#!/usr/bin/env python3
"""用视觉模型 mimo-v2.5 识别版面图 → 栏目条+文章归属，写入 column_test/YYYYMMDD_BC_vision.json

用法: python scripts/col_vision_run.py YYYYMMDD [BC]   (BC 缺省 = 全部 01-04)

视觉通道：xiaomi（api.xiaomimimo.com，XIAOMI_API_KEY），模型 mimo-v2.5
"""
import os, re, json, sys, time, base64, io, subprocess, tempfile
from PIL import Image

EPAPER_API = "http://epaper.zgqxb.com.cn/reader/layout"
API_BASE = "https://api.xiaomimimo.com/v1/chat/completions"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.environ.get("CMNRAG_DATA_DIR", os.path.join(ROOT, "cmnrag"))
OUT_DIR = os.path.join(OUT_DIR, "column_test")
PAGE_LABELS = {"01": "一版", "02": "二版", "03": "三版", "04": "四版"}
MODEL = "mimo-v2.5"

sys.path.insert(0, os.path.join(ROOT, "scripts"))
from column_detect import KNOWN_COLS


def get_key():
    env_path = os.path.join(ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                if "XIAOMI_API_KEY" in line:
                    return line.split("=", 1)[1].strip()
    return os.environ.get("XIAOMI_API_KEY")


def curl_post(url, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", "--connect-timeout", "5", "--max-time", "15", url, "-d", data],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20
    )
    if r.returncode != 0: return None
    try: return json.loads(r.stdout)
    except: return None


def get_articles(date_str, bc):
    date_dash = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    arts = curl_post(f"{EPAPER_API}/getBmDetail.do", f"bc={bc}&docpubtime={date_dash}")
    if not arts:
        return []
    titles = []
    for a in arts:
        t = a.get("DOCTITLE", "").strip()
        if t:
            titles.append(t)
    return titles


def b64_image(path, max_w=1600, quality=90):
    im = Image.open(path).convert("RGB")
    if im.width > max_w:
        h = int(im.height * max_w / im.width)
        im = im.resize((max_w, h), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def vision_call(img_b64, prompt, timeout=180):
    key = get_key()
    payload = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
        ]}],
        "max_tokens": 3000,
    }, ensure_ascii=False)
    fd, payload_path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(payload)
    cmd = [
        "curl", "-s", "--connect-timeout", "10", "--max-time", str(timeout),
        "-H", f"Authorization: Bearer {key}",
        "-H", "Content-Type: application/json",
        "-d", f"@{payload_path}",
        API_BASE,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout + 15)
    os.unlink(payload_path)
    if r.returncode != 0:
        return None, f"curl failed rc={r.returncode}"
    try:
        data = json.loads(r.stdout)
        if "error" in data:
            return None, json.dumps(data["error"], ensure_ascii=False)[:400]
        msg = data.get("choices", [{}])[0].get("message", {})
        return msg.get("content", ""), None
    except Exception as e:
        return None, f"parse error: {e} :: {r.stdout[:500]}"


def parse_json(content):
    c = content.strip()
    c = re.sub(r'^```(?:json)?\s*', '', c)
    c = re.sub(r'\s*```$', '', c)
    try:
        return json.loads(c)
    except Exception:
        m = re.search(r'\[.*\]', c, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
        return None


def build_prompt(date_str, bc, page_label, titles):
    cols_text = ", ".join(KNOWN_COLS)
    titles_text = "\n".join(f"{i+1}. {t}" for i, t in enumerate(titles))
    return (
        f"这是《中国气象报》{date_str} 的{page_label}（版面图）。\n\n"
        f"本版共有 {len(titles)} 篇文章，标题清单如下（序号与版面实际顺序一致）：\n"
        f"{titles_text}\n\n"
        f"已知栏目列表（识别栏目条时只能从这些名字中选择，尽量精确匹配）：\n"
        f"{cols_text}\n\n"
        f"任务：\n"
        f"1. 仔细观察版面图中的\"栏目条\"——即带底色、线框或特殊样式、位于整版或一组文章上方的栏目标识。注意：报头、导读、刊名不是栏目条；文章标题、引题、副题不是栏目条。\n"
        f"2. 如果整版顶部只有一个大的统一栏目条，本版所有文章都属于该栏目。\n"
        f"3. 将每篇文章（按标题清单逐条）归属到它所在栏目条对应的栏目；如果某篇文章上方没有栏目条，则归到离它最近的栏目条，或归空（不属于任何栏目）。\n"
        f"4. 只输出 JSON 数组，每项为 {{\"column\": \"栏目名\", \"articles\": [\"标题原文1\", \"标题原文2\"]}}，标题必须与清单原文一致。没有栏目条时输出空数组 []。不要输出任何解释。"
    )


def main():
    if hasattr(sys.stdout, "buffer") and sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        import io as _io
        sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if len(sys.argv) < 2:
        print("用法: python3 col_vision_run.py YYYYMMDD [BC]")
        sys.exit(1)
    date_str = sys.argv[1]
    bcs = [sys.argv[2]] if len(sys.argv) > 2 else list(PAGE_LABELS)
    os.makedirs(OUT_DIR, exist_ok=True)

    for bc in bcs:
        page = PAGE_LABELS.get(bc, bc)
        img_path = os.path.join(OUT_DIR, f"{date_str}_{bc}.jpg")
        if not os.path.exists(img_path):
            print(f"[!] {page} 图片不存在: {img_path}")
            continue
        titles = get_articles(date_str, bc)
        if not titles:
            print(f"[!] {page} 无法获取文章清单")
            continue
        print(f"\n{date_str} {page}: {len(titles)} 篇文章")

        prompt = build_prompt(date_str, bc, page, titles)
        img_b64 = b64_image(img_path)

        err, content = None, "no attempt"
        for attempt, delay in enumerate([0, 3, 6]):
            if attempt:
                time.sleep(delay)
            content, err = vision_call(img_b64, prompt)
            if content and content.strip() and "error" not in content.lower():
                break

        if not content:
            print(f"  [x] 视觉模型失败: {err}")
            continue

        data = parse_json(content)
        if data is None:
            print(f"  [x] 无法解析 JSON: {content[:300]}")
            continue

        out_path = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
        json.dump(data, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"  [ok] 已写入 {out_path}")
        for col_data in data:
            print(f"    「{col_data.get('column', '')}」: {len(col_data.get('articles', []))} 篇")


if __name__ == "__main__":
    main()
