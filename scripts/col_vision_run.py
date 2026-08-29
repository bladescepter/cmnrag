#!/usr/bin/env python3
"""用视觉模型 mimo-v2.5 识别版面图 → 栏目条+文章归属，写入 column_test/YYYYMMDD_BC_vision.json

用法: python scripts/col_vision_run.py YYYYMMDD [BC]   (BC 缺省 = 全部 01-04)
默认【整版识别+局部放大】模式：先整版一次识别看全局结构（整版刊头/通栏栏目条/栏目布局），
再对顶部通栏、中部上、中部下、版底 4 个横向条带（全宽不切列）裁剪放大并行细看，
补齐整版看不清的小字号/浅底色栏目条；输出前与 KNOWN_COLS 比对对齐。
可选参数：--crop 回退旧 3 列裁剪模式（调试用）；--full 回退整版一次识别（调试用）。

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
from column_detect import KNOWN_COLS, normalize_col, is_grounded_claim


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


def validate_vision_data(data, source):
    """过滤视觉模型输出：无当前图栏目条证据或库外栏目不得进入正式匹配。"""
    valid = []
    if not isinstance(data, list):
        print(f"  [{source}] 输出不是 JSON 数组，全部丢弃")
        return valid
    for item in data:
        if not is_grounded_claim(item):
            print(f"  [{source}] 丢弃无栏目条证据或库外名称的记录")
            continue
        valid.append({
            "column": normalize_col(item["column"]),
            "bar_visible": True,
            "bar_text": str(item["bar_text"]).strip(),
            "articles": [str(t).strip() for t in item["articles"] if str(t).strip()],
        })
    return valid


def build_crop_prompt(date_str, page_label, titles, region_label):
    titles_text = "\n".join(f"{i+1}. {t}" for i, t in enumerate(titles))
    cols_text = ", ".join(KNOWN_COLS)
    return (
        f"这是《中国气象报》{date_str} 的{page_label}版面【{region_label}】区域的裁剪放大图。\n\n"
        f"本版文章标题清单（序号与版面顺序一致）：\n{titles_text}\n\n"
        f"已知栏目库（只能使用其中的标准名称；栏目库只是命名白名单，不是图中存在栏目的证据）：\n{cols_text}\n\n"
        f"任务：只寻找本图区域内实际可见的【栏目条】——承载栏目名称的短条/横幅，通常有底色、边框或明确独立版式。浅色、小字号、窄条只要确实是栏目条也必须识别。\n"
        f"注意：栏目判断的唯一依据是图中实际可见的栏标，以及栏标文字与栏目库的严格比对。文章标题、引题、副题、报头、报眉、正文、图片说明、主题和普通装饰文字都不是栏目证据；绝不能据此产生栏目候选。\n"
        f"栏标确认后，才可从标题清单中按版面位置选出它『正下方、同属一个版块』的文章；标题清单只用于归属映射，不用于判断栏目存在。栏标文字必须抄录到 bar_text，并将 bar_visible 设为 true；看不清归属就不归入。\n"
        f"只输出 JSON 数组：[{{\"column\":\"库内标准栏目名\",\"bar_visible\":true,\"bar_text\":\"图中栏目条原文\",\"articles\":[\"标题原文1\",...]}}]；本区域没有明确栏目条就输出 []。不要解释。"
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
            valid = validate_vision_data(data, label)
            results.extend(valid)
            cols = [d.get("column", "") for d in valid if d.get("column")]
            print(f"  [{label}] ok: {cols if cols else '无有效栏目条'}")
    # 汇总合并：必须先通过“当前图中确有栏目条 + 严格命中栏目库”校验。
    merged = {}
    evidence = {}
    for d in results:
        col = d["column"]
        evidence.setdefault(col, set()).add(d["bar_text"])
        for t in d.get("articles", []):
            merged.setdefault(col, set()).add(str(t).strip())
    return [{"column": c, "bar_visible": True,
             "bar_text": sorted(evidence[c])[0],
             "articles": sorted(list(arts))}
            for c, arts in merged.items() if c]


def merge_column_claims(claims, titles):
    """合并已通过栏目条证据校验的认领，不以覆盖率猜测或删除真实栏目。
    claims: [(source, column, [article,...]), ...]，source ∈ {整版, 顶部通栏, 中部上, 中部下, 版底}
    规则：
      1. 每条认领必须来自当前图中可见栏目条，栏目名严格命中 KNOWN_COLS；
      2. 同一文章被多个不同栏目认领 → 放大条带来源、多视图优先仲裁；
      3. 栏目条覆盖几篇由版面实际结构决定，禁止用覆盖率安全阈值造成漏栏目。
    """
    art_claims = {}   # article -> {col: set(source)}
    dropped = []
    evidence = {}
    for src, col, arts, bar_text in claims:
        c = normalize_col(col)
        if not c:
            raw = (col or "").strip()
            if raw:
                dropped.append(raw)
            continue
        evidence.setdefault(c, set()).add(str(bar_text).strip())
        for t in arts:
            ts = str(t).strip()
            art_claims.setdefault(ts, {}).setdefault(c, set()).add(src)
    if dropped:
        print(f"  [汇总] 丢弃库外栏目名: {sorted(set(dropped))}")

    # 冲突仲裁：一篇文章被多个栏目认领 → 择一（条带>整版，多视图>少，先出现定序）
    resolved = {}
    for art, colmap in art_claims.items():
        if len(colmap) == 1:
            resolved[art] = next(iter(colmap))
            continue

        def _rank(item):
            col, sources = item
            bands = [s for s in sources if s != "整版"]
            return (len(bands) > 0, len(sources), col)

        best = max(colmap.items(), key=_rank)
        print(f"  [仲裁] 「{art[:22]}」被 {sorted(colmap)} 认领 → 取「{best[0]}」")
        resolved[art] = best[0]

    # 按栏目聚合
    merged = {}
    for art, col in resolved.items():
        merged.setdefault(col, []).append(art)

    return [{"column": c, "bar_visible": True,
             "bar_text": sorted(evidence.get(c, {c}))[0],
             "articles": sorted(set(a))}
            for c, a in merged.items() if a]


def run_whole_zoom_mode(date_str, bc, page, img_path, titles):
    """整版识别 + 局部放大扫描（默认模式）：
    Phase 1 整版一次识别——看全局结构（整版刊头、通栏栏目条、多栏目布局）；
    Phase 2 对 4 个横向条带（顶部通栏/中部上/中部下/版底）裁剪放大并行细看，
          补齐整版看不清的小字号/浅底色栏目条。
    横向条带全宽不切列，横幅栏目条完整可见（旧 3 列纵切会把横幅切碎导致漏识）。
    归属合并：局部细看结果优先（放大更可信），整版结果补漏（策划版整版刊头管辖全版）。
    """
    claims = []

    # Phase 1: 整版一次识别
    prompt_full = build_prompt(date_str, bc, page, titles)
    img_b64 = b64_image(img_path)
    content, err = _call_retry(img_b64, prompt_full)
    if content:
        data = parse_json(content)
        if data is None:
            print(f"  [整版] 无法解析 JSON: {content[:200]}")
        else:
            valid = validate_vision_data(data, "整版")
            for d in valid:
                claims.append(("整版", d["column"], d["articles"], d["bar_text"]))
            cols = [d["column"] for d in valid]
            print(f"  [整版] ok: {cols if cols else '无有效栏目条'}")
    else:
        print(f"  [整版] 视觉模型失败: {err}")

    # Phase 2: 横向条带放大扫描（全宽，带重叠防条带边缘截断）
    BANDS = [(0.00, 0.34, "顶部通栏"), (0.30, 0.62, "中部上"), (0.58, 0.84, "中部下"), (0.80, 1.00, "版底")]
    jobs = []
    for y0, y1, label in BANDS:
        b64 = crop_b64(img_path, (0.0, y0, 1.0, y1))
        jobs.append((label, b64, build_crop_prompt(date_str, page, titles, label)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
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
            valid = validate_vision_data(data, label)
            for d in valid:
                claims.append((label, d["column"], d["articles"], d["bar_text"]))
            cols = [d["column"] for d in valid]
            print(f"  [{label}] ok: {cols if cols else '无有效栏目条'}")

    # 汇总合并：只合并有当前版面栏目条证据的有效认领，不凭覆盖率猜测
    data = merge_column_claims(claims, titles)
    return data


def write_vision(date_str, bc, data, titles, mode_label):
    """写 vision.json + 覆盖统计打印（三种模式共用）"""
    out_path = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
    json.dump(data, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"  [ok] {mode_label}已写入 {out_path}")
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


def build_prompt(date_str, bc, page_label, titles):
    cols_text = ", ".join(KNOWN_COLS)
    titles_text = "\n".join(f"{i+1}. {t}" for i, t in enumerate(titles))
    return (
        f"这是《中国气象报》{date_str} 的{page_label}（版面图）。\n\n"
        f"本版共有 {len(titles)} 篇文章，标题清单如下（序号与版面实际顺序一致）：\n"
        f"{titles_text}\n\n"
        f"已知栏目库（只能使用其中的标准名称；栏目库只是命名白名单，不是图中存在栏目的证据）：\n"
        f"{cols_text}\n\n"
        f"任务：\n"
        f"1. 仔细观察版面图中实际存在的\"栏目条\"——承载栏目名称的短条/横幅，通常有底色、边框或明确独立版式。浅色、小字号、窄条只要确实是栏目条也必须识别；文章标题、引题、副题、报头、报眉、导读、刊名不是栏目条。\n"
        f"2. 只有图中确实看见并确认其承担栏目标题的整版刊头，才按实际版块边界归属文章；不能仅凭策划版/专题版类型自动覆盖。\n"
        f"3. 将每篇文章（按标题清单逐条）归属到它所在栏目条：只把『栏目条正下方、与其同属一个版块』的文章归入；绝大多数文章上方没有栏目条（常规版正常排版），没有栏目条就归空。\n"
        f"4. 栏目标识的唯一证据是图中实际可见的栏标及其与栏目库的严格比对；正文、文章标题、引题、副题、主题、版面名、位置邻近、历史出现过或库中有该名称，都不能证明栏目存在。若看见的栏标文字对应库内名称，必须逐字使用库中标准名称，禁止近义替换和相似度/子串强行匹配。\n"
        f"5. 每条输出必须抄录图中栏目条文字到 bar_text，并将 bar_visible 设为 true：{{\"column\": \"库内标准栏目名\", \"bar_visible\": true, \"bar_text\": \"图中栏目条原文\", \"articles\": [\"标题原文1\", \"标题原文2\"]}}。标题必须与清单原文一致；没有明确栏目条时输出空数组 []。不要输出任何解释。"
    )


def main():
    if hasattr(sys.stdout, "buffer") and sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        import io as _io
        sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if len(sys.argv) < 2:
        print("用法: python3 col_vision_run.py YYYYMMDD [BC]")
        sys.exit(1)
    date_str = sys.argv[1]
    # 默认【整版识别+局部放大】模式；--crop 回退旧 3 列裁剪模式（调试用）；--full 回退整版一次识别（调试用）
    mode = "whole_zoom"
    if "--crop" in sys.argv:
        mode = "crop"
    elif "--full" in sys.argv:
        mode = "full"
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

        if mode in ("crop", "whole_zoom"):
            if mode == "crop":
                data = run_crop_mode(date_str, bc, page, img_path, titles)
                mode_label = "裁剪扫描"
            else:
                data = run_whole_zoom_mode(date_str, bc, page, img_path, titles)
                mode_label = "整版+局部放大"
            write_vision(date_str, bc, data, titles, mode_label)
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
        data = validate_vision_data(data, "整版")

        out_path = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
        json.dump(data, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"  [ok] 已写入 {out_path}")
        for col_data in data:
            print(f"    「{col_data.get('column', '')}」: {len(col_data.get('articles', []))} 篇")


if __name__ == "__main__":
    main()
