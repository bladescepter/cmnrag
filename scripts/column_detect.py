#!/usr/bin/env python3
"""
栏目识别、frontmatter 写入与格式闸门脚本

用法:
  python3 column_detect.py YYYYMMDD [BC]    # 指定日期+版次
  python3 column_detect.py YYYYMMDD          # 指定日期，全部版

输出:
  <项目根>/cmnrag/column_test/YYYYMMDD_BC_result.json
  控制台打印检测+对比结果
  识别结果默认写入稿件 frontmatter 的 column（严格使用 YAML 块式 list）

选项:
  --no-apply  仅生成/打印结果，不写入 frontmatter（调试用）
  --check     只检查目标稿件的 author/column/region 是否为 YAML list 或空值

依赖: vision_analyze（由调用者执行，结果写入 _vision.json 后脚本自动读取）
"""
import subprocess, json, os, sys, re

API_BASE = "http://epaper.zgqxb.com.cn/reader/layout"
IMG_BASE = "http://epaper.zgqxb.com.cn"
OUT_DIR = os.environ.get("CMNRAG_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmnrag"))
OUT_DIR = os.path.join(OUT_DIR, "column_test")
PAGE_LABELS = {"01": "一版", "02": "二版", "03": "三版", "04": "四版"}

KNOWN_COLS = ['短讯速递', '气象行业统筹试点成效系列报道', '科普看台', '气象博观', '党旗在基层一线高高飘扬', '科技视野', '汛期气象科技支撑系列报道', '气象观天下', '振兴 乡村小而美', '时评', '权威解读', '领略 国际气象发展前沿', '党旗在防汛一线飘扬', '强化政治机关意识 走好第一方阵', '我在现场', '树立和践行正确政绩观', '漫评', '科普一读', '要闻简报', '强化政治机关意识 走好第一方阵•学思践悟', '树品牌 亮特色', '编辑点评', '双碳行动', '国际天气观察站', '在希望的田野上', '安全生产', '气象服务领域数据流通安全治理典型案例', '深度调研', '锋评', '强化政治机关意识 走好第一方阵•评论', '强化政治机关意识 走好第一方阵•榜样力量', '我和天气打交道', '春雨日记', '气象科技能力现代化 社会服务现代化•科技创新', '气象科技能力现代化 社会服务现代化•解码气象科技', '强化政治机关意识 走好第一方阵', '“七下八上”防汛关键期系列报道', '“人民至上、生命至上”主题实践活动 发挥气象防灾减灾第一道防线作用', '“人民至上、生命至上”主题实践活动•先锋', '“十五五“气象高质量发展怎么干', '“十五五”开好局起好步', '“扎实做好防灾救灾各项工作”系列评论', '“打赢‘七下八上’防汛救灾硬仗”系列评论', '“气象+”赋能经济社会高质量发展', '亲历者记忆', '党建纵览', '农业气候资源普查和区划•看试点', '古韵廉心•清风悟语 | 丹心话廉', '名士观点', '天气观察站', '空间天气课堂', '守正创新 奉献气象•弘扬新时代科学家精神主题实践活动典型案例', '总书记的关切•落地回响', '权威发布', '树立和践行正确政绩观•学典型', '环球视线', '科技资源科普化', '聚焦气象科技活动周', '能源气象服务适用技术成果', '记者观察', '谈天说“理”', '践行“观测及服务”理念 赋能气象服务提质增效', '地方领导谈气象', '高质量发展中国行 新时代的气象万千', '高质量发展看试点', '强化政治机关意识 走好第一方阵•一线答卷', '聚焦北方地区极端天气防御能力建设', '清廉气象', '千乡万村气象科普行', '微话题', '云海', '中国气象智能预警方案“妈祖”', '走长征万里 看气象万千', '跟着总书记看气象', '研值观察站', '全国科普月', '气象科普月', '风雨长望 纪念涂长望先生诞辰120周年', '健康中国·气象行动', '庆祝中国共产党成立105周年']


# 用户确认的栏目别名：版面出现该变体时统一写入标准栏目名。
COLUMN_ALIASES = {
    '党旗在防汛减灾一线飘扬': '党旗在防汛一线飘扬',
}


def _column_key(value):
    """只做空白归一化；禁止用相似度/子串把幻觉映射成已知栏目。"""
    return re.sub(r"\s+", "", str(value or "").strip())


def normalize_col(col):
    """将模型输出严格对齐到已知栏目库；非精确命中一律返回空字符串。"""
    key = _column_key(col)
    if not key:
        return ""
    for known in KNOWN_COLS:
        if _column_key(known) == key:
            return known
    for alias, standard in COLUMN_ALIASES.items():
        if _column_key(alias) == key:
            return standard
    return ""


def is_grounded_claim(item):
    """栏目归属必须有模型明确声明的当前版面栏目条证据。"""
    if not isinstance(item, dict) or item.get("bar_visible") is not True:
        return False
    column = normalize_col(item.get("column"))
    bar_text = str(item.get("bar_text") or "").strip()
    articles = item.get("articles")
    if not column or not bar_text or not isinstance(articles, list):
        return False
    # 栏标是唯一证据：bar_text 至少要包含标准栏目名，避免用空泛描述伪造“看见栏目条”。
    # 文章标题/正文/主题不参与栏目候选判断；这里只校验栏标文字与栏目库的比对。
    bar_key = _column_key(bar_text)
    if _column_key(column) in bar_key:
        return True
    # 栏目别名允许栏标原文与标准栏目名不完全连续匹配。
    return any(target == column and _column_key(alias) in bar_key
               for alias, target in COLUMN_ALIASES.items())


def curl_post(url, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", "--connect-timeout", "5", "--max-time", "15", url, "-d", data],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20
    )
    if r.returncode != 0: return None
    try: return json.loads(r.stdout)
    except: return None


def normalize(s):
    """统一标点、空格、全半角括号用于模糊匹配"""
    for ch in '\u201c\u201d\u3001\u2022\u00b7\u3000 （）':
        s = s.replace(ch, "")
    s = s.replace("(", "").replace(")", "")
    return s.strip()


LIST_FIELDS = ("author", "column", "region")


def _frontmatter_bounds(lines):
    """返回 YAML frontmatter 的 (start, end)，end 为第二个 --- 的行号。"""
    if not lines or lines[0].lstrip("\ufeff").strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return 0, i
    return None


def _frontmatter_field(lines, start, end, field):
    """读取字段的行号、行内值和块式列表项。"""
    prefix = f"{field}:"
    for i in range(start + 1, end):
        raw = lines[i].rstrip("\r\n")
        if not raw.startswith(prefix) or (len(raw) > len(prefix) and raw[len(prefix)] not in " \t"):
            continue
        inline = raw[len(prefix):].strip()
        items = []
        j = i + 1
        while j < end:
            item_raw = lines[j].rstrip("\r\n")
            if not re.match(r"^\s*-\s*", item_raw):
                break
            if re.match(r"^  - \S.*$", item_raw):
                items.append(item_raw[4:].strip())
            else:
                items.append(None)
            j += 1
        return i, inline, items
    return None, None, None


def _render_list_field(field, values, newline="\n"):
    """渲染单值也保持块式 YAML list；空值只写 key。"""
    values = [str(v).strip() for v in (values or []) if str(v).strip()]
    if not values:
        return f"{field}: {newline}"
    return f"{field}:{newline}" + "".join(f"  - {v}{newline}" for v in values)


def _replace_list_field_text(text, field, values):
    """只替换 frontmatter 中一个字段，并保证 list 序列化格式。"""
    lines = text.splitlines(keepends=True)
    bounds = _frontmatter_bounds(lines)
    if not bounds:
        raise ValueError("缺少合法 frontmatter")
    start, end = bounds
    field_i, _, _ = _frontmatter_field(lines, start, end, field)
    if field_i is None:
        raise ValueError(f"frontmatter 缺少字段 {field}")
    j = field_i + 1
    while j < end and re.match(r"^\s*-\s*", lines[j].rstrip("\r\n")):
        j += 1
    newline = "\r\n" if "\r\n" in text else "\n"
    block = _render_list_field(field, values, newline).splitlines(keepends=True)
    return "".join(lines[:field_i] + block + lines[j:])


def _article_files(date_str, bc):
    data_root = os.path.dirname(OUT_DIR)
    page_dir = os.path.join(data_root, date_str[:6], date_str, PAGE_LABELS.get(bc, bc))
    if not os.path.isdir(page_dir):
        return []
    paths = [os.path.join(page_dir, name) for name in os.listdir(page_dir)
             if name.endswith(".md")]
    return sorted(paths, key=lambda p: (int(re.match(r"\d+", os.path.basename(p)).group())
                                        if re.match(r"\d+", os.path.basename(p)) else 9999,
                                        os.path.basename(p)))


def _article_meta(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    lines = text.splitlines(keepends=True)
    bounds = _frontmatter_bounds(lines)
    if not bounds:
        return {"path": path, "title": "", "image": False}
    start, end = bounds
    _, title, _ = _frontmatter_field(lines, start, end, "title")
    image = any(re.match(r"^image:\s*true\s*$", lines[i].rstrip("\r\n"), re.I)
                for i in range(start + 1, end))
    return {"path": path, "title": title or "", "image": image}


def _match_local_article(api_title, articles, used, image_index):
    """将 API/视觉标题映射到本地稿件；去重稿件不强行映射。"""
    if api_title.strip() == "图片新闻":
        image_articles = [a for a in articles if a["image"] and a["path"] not in used]
        if image_index < len(image_articles):
            return image_articles[image_index], image_index + 1
        return None, image_index

    key = normalize(api_title)
    exact = [a for a in articles if a["path"] not in used and normalize(a["title"]) == key]
    if len(exact) == 1:
        return exact[0], image_index
    fuzzy = [a for a in articles if a["path"] not in used and
             fuzzy_title_match(api_title, [a["title"]])]
    if len(fuzzy) == 1:
        return fuzzy[0], image_index
    return None, image_index


def apply_columns_to_page(date_str, bc, results):
    """把检测到的非空栏目写入空 column；已有值一律保留，避免覆盖审核结果。"""
    articles = [_article_meta(p) for p in _article_files(date_str, bc)]
    if not articles:
        print(f"  [!] {PAGE_LABELS.get(bc, bc)} 没有本地稿件，跳过 frontmatter 写入")
        return

    used = set()
    image_index = 0
    updated = 0
    skipped = 0
    for result in results:
        columns = [str(c).strip() for c in (result.get("detected_columns") or []) if str(c).strip()]
        if not columns:
            continue
        article, image_index = _match_local_article(
            str(result.get("title") or ""), articles, used, image_index
        )
        if not article:
            skipped += 1
            continue
        path = article["path"]
        with open(path, encoding="utf-8") as f:
            text = f.read()
        lines = text.splitlines(keepends=True)
        bounds = _frontmatter_bounds(lines)
        if not bounds:
            print(f"  [x] {os.path.basename(path)} 缺少合法 frontmatter")
            continue
        start, end = bounds
        _, inline, items = _frontmatter_field(lines, start, end, "column")
        if inline:
            print(f"  [x] {os.path.basename(path)} 的 column 是标量，拒绝覆盖")
            continue
        if items:
            # 审核前后均不覆盖已有栏目；差异交人工处理。
            if items != columns:
                print(f"  [保留] {os.path.basename(path)} 已有栏目，未覆盖")
            used.add(path)
            continue
        new_text = _replace_list_field_text(text, "column", columns)
        if new_text != text:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(new_text)
            updated += 1
        used.add(path)

    print(f"  [ok] {PAGE_LABELS.get(bc, bc)} frontmatter 栏目写入 {updated} 篇"
          + (f"，未映射/跳过 {skipped} 条" if skipped else ""))


def _validate_frontmatter_file(path):
    errors = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines(keepends=True)
    except Exception as e:
        return [f"{path}: 无法读取：{e}"]
    bounds = _frontmatter_bounds(lines)
    if not bounds:
        return [f"{path}: 缺少合法 frontmatter"]
    start, end = bounds
    for field in LIST_FIELDS:
        field_i, inline, _ = _frontmatter_field(lines, start, end, field)
        if field_i is None:
            errors.append(f"{path}: 缺少字段 {field}")
            continue
        if inline:
            errors.append(f"{path}: {field} 使用了标量，必须是 YAML 块式 list")
            continue
        j = field_i + 1
        while j < end:
            raw = lines[j].rstrip("\r\n")
            if not re.match(r"^\s*-\s*", raw):
                break
            if not re.match(r"^  - \S.*$", raw):
                errors.append(f"{path}: {field} 列表项格式错误：{raw}")
            j += 1
    return errors


def validate_frontmatter_tree(date_str, bcs):
    """失败即停：所有目标稿件的多值字段只能是 list 或空值。"""
    errors = []
    checked = 0
    data_root = os.path.dirname(OUT_DIR)
    for bc in bcs:
        page_dir = os.path.join(data_root, date_str[:6], date_str, PAGE_LABELS.get(bc, bc))
        if not os.path.isdir(page_dir):
            continue
        for path in _article_files(date_str, bc):
            checked += 1
            errors.extend(_validate_frontmatter_file(path))
    if errors:
        print(f"  [x] frontmatter list 闸门失败：{len(errors)} 处")
        for error in errors:
            print(f"    - {error}")
        return False
    print(f"  [ok] frontmatter list 闸门通过：{checked} 篇")
    return True


def get_page_data(date_str, bc):
    date_dash = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    editions = curl_post(f"{API_BASE}/findBmMenu.do", f"docPubTime={date_str}")
    if not editions: return None
    jppath = None
    for ed in editions:
        if ed.get("IRCATELOG") == bc:
            jppath = ed.get("JPPATH")
            break
    if not jppath: return None
    articles = curl_post(f"{API_BASE}/getBmDetail.do", f"bc={bc}&docpubtime={date_dash}")
    if not articles: return None
    return {"jppath": jppath, "articles": articles, "bc": bc,
            "page": PAGE_LABELS.get(bc, bc)}


def download_image(jppath, date_str, bc):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{date_str}_{bc}.jpg")
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    subprocess.run(["curl", "-s", "-o", path, "--connect-timeout", "10", "--max-time", "30",
                    f"{IMG_BASE}/{jppath}"], capture_output=True, timeout=35)
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return path
    return None


def cleanup_page_images(date_str, bc):
    """清理栏目识别流程产生的版面原图和所有裁剪图，保留 JSON 结果。"""
    prefix = f"{date_str}_{bc}"
    names = [
        f"{prefix}.jpg",
        f"{prefix}_full.jpg",
        *(f"{prefix}_band{i}.jpg" for i in range(4)),
        *(f"{prefix}_col{i}.jpg" for i in range(3)),
    ]
    removed = 0
    failed = []
    for name in names:
        path = os.path.join(OUT_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            os.remove(path)
            removed += 1
        except OSError as exc:
            failed.append(f"{name}: {exc}")
    if removed:
        print(f"  [ok] 已删除 {removed} 个版面临时图片（{prefix}）")
    for error in failed:
        print(f"  [!] 删除版面临时图片失败：{error}")


def fuzzy_title_match(api_title, vision_titles):
    """渐进式前缀匹配（全→10→8→6→4字）"""
    api_norm = normalize(api_title)
    for vt in vision_titles:
        vt_norm = normalize(vt)
        for n in [len(api_norm), 10, 8, 6, 4]:
            if n < 2: continue
            if api_norm[:n] in vt_norm or vt_norm[:n] in api_norm:
                return True
    return False


def match_columns(vision_data, api_articles):
    """视觉结果 → API 文章的栏目归属

    一篇稿件可同时命中多个真实栏条（如策划版整版刊头「科普看台」+ 局部「微话题」），
    按 vision.json 顺序全部保留；双栏目情况极少，但版面上两个栏条都可见时不得漏记。
    """
    results = []
    for guid_title in api_articles:
        guid, title = guid_title
        detected = []
        for col_data in vision_data:
            # 只接受带有当前版面栏目条证据、且严格命中 KNOWN_COLS 的记录。
            if not is_grounded_claim(col_data):
                continue
            col = normalize_col(col_data.get("column"))
            if col in detected:
                continue
            if fuzzy_title_match(title, col_data["articles"]):
                detected.append(col)
        # 注：不做"整版只有一个栏目则全部归入"的兜底——
        # 局部栏目条（如某版只有一处"短讯速递"）会把无关文章误归入；
        # 整版统一栏目时 vision 的 articles 已含全部标题，fuzzy 匹配即可命中。
        results.append({"guid": guid, "title": title, "detected_columns": detected})
    return results


def run_vision(img_path, date_str, bc, page_label):
    """无 vision.json 时提示：由当前 LLM 读版面图（col_vision_run.py 准备图片）后写入结果。"""
    vision_json = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
    print(f"\n  >>> {page_label} 缺少 {os.path.basename(vision_json)}")
    print(f"  请先运行: python scripts/col_vision_run.py {date_str} {bc}")
    print(f"  当前 LLM 读生成的版面图/条带图完成栏目识别，写: {vision_json}")
    print(f"  格式: [{{\"column\": \"库内标准栏目名\", \"bar_visible\": true, \"bar_text\": \"图中栏目条原文\", \"articles\": [\"标题1\"]}}]")
    print(f"  自检: python scripts/col_vision_run.py --validate {date_str} {bc}")
    return vision_json


def evaluate(date_str, bc, results):
    page = PAGE_LABELS.get(bc, bc)
    print(f"\n{'='*70}")
    print(f"{page}")
    print(f"{'='*70}")
    for i, r in enumerate(results):
        order = f"{i+1:02d}"
        det_col = "、".join(r.get("detected_columns") or [])
        print(f"  {order} {r['title'][:28]:30s} 栏目={det_col[:40] or '(空)'}")


def main():
    if hasattr(sys.stdout, "buffer") and sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        import io as _io
        sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if len(sys.argv) < 2:
        print("用法: python3 column_detect.py YYYYMMDD [BC] [--no-apply|--check]")
        sys.exit(1)
    args = sys.argv[1:]
    date_str = args[0]
    bcs = [a for a in args[1:] if a in PAGE_LABELS] or ["01", "02", "03", "04"]
    apply_results = "--no-apply" not in args
    os.makedirs(OUT_DIR, exist_ok=True)

    if "--check" in args:
        sys.exit(0 if validate_frontmatter_tree(date_str, bcs) else 2)

    # 写入前先拦截已有的标量/坏格式，避免批处理中途部分写入后才失败。
    if not validate_frontmatter_tree(date_str, bcs):
        print("  [x] 写入前闸门未通过，停止栏目写入")
        sys.exit(2)

    completed_bcs = []
    for bc in bcs:
        page = PAGE_LABELS.get(bc, bc)
        data = get_page_data(date_str, bc)
        if not data:
            print(f"[!] 无法获取 {page} 数据")
            continue
        img_path = download_image(data["jppath"], date_str, bc)
        if not img_path:
            print(f"[!] 无法下载 {page} 图片")
            continue
        print(f"\n{date_str} {page}: {len(data['articles'])} 篇文章")

        vision_json = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
        if os.path.exists(vision_json):
            vision_data = json.load(open(vision_json, encoding="utf-8"))
            api_articles = [(a["ZB_GUID"], a["DOCTITLE"]) for a in data["articles"]]
            results = match_columns(vision_data, api_articles)
            evaluate(date_str, bc, results)
            # 保存结果
            out_path = os.path.join(OUT_DIR, f"{date_str}_{bc}_result.json")
            json.dump(results, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
            if apply_results:
                apply_columns_to_page(date_str, bc, results)
            completed_bcs.append(bc)
        else:
            run_vision(img_path, date_str, bc, page)

    if not validate_frontmatter_tree(date_str, bcs):
        sys.exit(2)

    # 只有整批流程通过最终闸门后才清理图片，保留 vision/result JSON 供复核。
    for bc in completed_bcs:
        cleanup_page_images(date_str, bc)


if __name__ == "__main__":
    main()
