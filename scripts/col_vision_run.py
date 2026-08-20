#!/usr/bin/env python3
"""用视觉模型 mimo-v2.5 识别版面图 → 栏目条+文章归属，写入 column_test/YYYYMMDD_BC_vision.json

用法: python scripts/col_vision_run.py YYYYMMDD [BC]   (BC 缺省 = 全部 01-04)
默认【裁剪扫描模式】：每版按 3 列裁剪放大逐区识别（并行），输出前与 KNOWN_COLS 比对对齐；
可选参数 --full：回退整版一次识别（旧模式，调试用）。

视觉通道：xiaomi（api.xiaomimimo.com，XIAOMI_API_KEY），模型 mimo-v2.5
"""
import os, re, json, sys, time, base64, io, subprocess, tempfile, concurrent.futures
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


def crop_b64(path, box, out_w=1400, quality=88):
    """按归一化坐标裁剪区域并放大，返回 base64（用于局部扫描）"""
    im = Image.open(path).convert("RGB")
    W, H = im.size
    c = im.crop((int(W * box[0]), int(H * box[1]), int(W * box[2]), int(H * box[3])))
    if c.width > out_w:
        c = c.resize((out_w, int(c.height * out_w / c.width)), Image.LANCZOS)
    buf = io.BytesIO()
    c.save(buf, "JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def _lcs(a, b):
    """最长连续公共子串长度（小串暴力，a/b 均短）"""
    if len(a) > len(b):
        a, b = b, a
    n = len(a)
    for L in range(n, 0, -1):
        for i in range(n - L + 1):
            if a[i:i + L] in b:
                return L
    return 0


def normalize_col(col):
    """栏目名对齐到 KNOWN_COLS：精确命中→库内最长公共子串合并（≥5 字）→丢弃(返回空)。
    解决：横幅跨列切碎、国际栏目前缀缺失、OCR 微差（如“宣传/实践”）"""
    col = (col or "").strip()
    if not col:
        return ""
    if col in KNOWN_COLS:
        return col
    best, best_len = "", 0
    for k in KNOWN_COLS:
        ln = _lcs(col, k)
        if ln > best_len:
            best, best_len = k, ln
    if best_len >= 5:
        return best
    return ""


def build_crop_prompt(date_str, page_label, titles, region_label):
    titles_text = "\n".join(f"{i+1}. {t}" for i, t in enumerate(titles))
    cols_text = ", ".join(KNOWN_COLS)
    return (
        f"这是《中国气象报》{date_str} 的{page_label}版面【{region_label}】区域的裁剪放大图。\n\n"
        f"本版文章标题清单（序号与版面顺序一致）：\n{titles_text}\n\n"
        f"已知栏目列表（识别栏目条时只能从这些名字中选择，尽量精确匹配）：\n{cols_text}\n\n"
        f"任务：只寻找本图区域内的【栏目条】——带底色（红底白字/蓝底白字/浅灰底/黄底等）或线框的短标签，或整版刊头横幅（红底、可能带'第X期/总第X期'字样）。\n"
        f"注意：不设醒目度门槛，小字号/浅底色/细线框的短标签都算；文章标题、引题、副题、报头、报眉、正文、图片说明不是栏目条。\n"
        f"对每个栏目条，从上方标题清单中选出它下方/附近的文章标题（标题必须与清单原文一致）。\n"
        f"只输出 JSON 数组：[{{\"column\":\"栏目名\",\"articles\":[\"标题原文1\",...]}}]；本区域没有栏目条就输出 []。不要解释。"
    )


def _call_retry(img_b64, prompt):
    """带重试的单次视觉调用（复用整版模式的 0/3/6s 退避）"""
    content, err = None, None
    for attempt, delay in enumerate([0, 3, 6]):
        if attempt:
            time.sleep(delay)
        content, err = vision_call(img_b64, prompt)
        if content and content.strip() and "error" not in content.lower():
            break
    return content, err


def run_crop_mode(date_str, bc, page, img_path, titles):
    """按列裁剪扫描：3 列（带重叠）并行识别，汇总合并，返回 [{column, articles}]"""
    COLS = [(0.00, 0.40, "左列"), (0.35, 0.75, "中列"), (0.70, 1.00, "右列")]
    jobs = []
    for x0, x1, label in COLS:
        img_b64 = crop_b64(img_path, (x0, 0.0, x1, 1.0))
        prompt = build_crop_prompt(date_str, page, titles, label)
        jobs.append((label, img_b64, prompt))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        futs = {ex.submit(_call_retry, b, p): (label, b, p) for label, b, p in jobs}
        for fut in concurrent.futures.as_completed(futs):
            label = futs[fut][0]
            content, err = fut.result()
            if not content:
                print(f"  [{label}] 视觉模型失败: {err}")
                continue
            data = parse_json(content)
            if data is None:
                print(f"  [{label}] 无法解析 JSON: {content[:200]}")
                continue
            results.extend(data)
            cols = [d.get("column", "") for d in data if isinstance(d, dict) and d.get("column")]
            print(f"  [{label}] ok: {cols if cols else '无栏目条'}")
    # 汇总合并：栏目名先对齐到 KNOWN_COLS（精确/子串合并/丢弃），再聚合去重
    merged = {}
    dropped = []
    for d in results:
        if not isinstance(d, dict):
            continue
        col = normalize_col(d.get("column"))
        if not col:
            raw = (d.get("column") or "").strip()
            if raw:
                dropped.append(raw)
            continue
        for t in d.get("articles", []):
            merged.setdefault(col, set()).add(str(t).strip())
    if dropped:
        print(f"  [汇总] 丢弃库外栏目名: {sorted(set(dropped))}")
    return [{"column": c, "articles": sorted(list(arts))} for c, arts in merged.items() if c]


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
    # 默认裁剪扫描模式（与 KNOWN_COLS 比对对齐）；--full 回退整版一次识别；--crop 为旧参数兼容
    crop_mode = "--full" not in sys.argv
    if "--crop" in sys.argv:
        crop_mode = True
    bcs = [a for a in sys.argv[2:] if a in PAGE_LABELS] or list(PAGE_LABELS)
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

        if crop_mode:
            data = run_crop_mode(date_str, bc, page, img_path, titles)
            out_path = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
            json.dump(data, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
            print(f"  [ok] 裁剪扫描已写入 {out_path}")
            covered = set()
            for col_data in data:
                print(f"    「{col_data.get('column', '')}」: {len(col_data.get('articles', []))} 篇")
                covered.update(str(t) for t in col_data.get("articles", []))
            # 信息性覆盖统计（不警报）：常规版未覆盖属正常（空栏目），策划版才需人工核对
            uncovered = [t for t in titles
                         if not any(str(t) in c or c in str(t) for c in covered)]
            print(f"  [统计] 栏目覆盖 {len(titles)-len(uncovered)}/{len(titles)} 篇")
            if uncovered:
                print(f"  未覆盖（常规版空栏目正常，策划版请人工核对）：")
                for t in uncovered:
                    print(f"    - {t}")
            continue

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
