#!/usr/bin/env python3
"""
栏目自动识别脚本（试验性质，不写入正式数据）

用法:
  python3 column_detect.py YYYYMMDD [BC]    # 指定日期+版次
  python3 column_detect.py YYYYMMDD          # 指定日期，全部版

输出:
  <项目根>/cmnrag/column_test/YYYYMMDD_BC_result.json
  控制台打印检测+对比结果

依赖: vision_analyze（由调用者执行，结果写入 _vision.json 后脚本自动读取）
"""
import subprocess, json, os, sys, re

API_BASE = "http://epaper.zgqxb.com.cn/reader/layout"
IMG_BASE = "http://epaper.zgqxb.com.cn"
OUT_DIR = os.environ.get("CMNRAG_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmnrag"))
OUT_DIR = os.path.join(OUT_DIR, "column_test")
PAGE_LABELS = {"01": "一版", "02": "二版", "03": "三版", "04": "四版"}

KNOWN_COLS = ['短讯速递', '科普看台', '气象博观', '党旗在基层一线高高飘扬', '科技视野', '汛期气象科技支撑系列报道', '气象观天下', '振兴 乡村小而美', '时评', '权威解读', '领略 国际气象发展前沿', '党旗在防汛一线飘扬', '强化政治机关意识 走好第一方阵', '我在现场', '树立和践行正确政绩观', '漫评', '科普一读', '要闻简报', '强化政治机关意识 走好第一方阵•学思践悟', '编辑点评', '双碳行动', '国际天气观察站', '在希望的田野上', '安全生产', '气象服务领域数据流通安全治理典型案例', '深度调研', '锋评', '强化政治机关意识 走好第一方阵•评论', '强化政治机关意识 走好第一方阵•榜样力量', '我和天气打交道', '春雨日记', '气象科技能力现代化 社会服务现代化•科技创新', '气象科技能力现代化 社会服务现代化•解码气象科技', '强化政治机关意识 走好第一方阵', '“七下八上”防汛关键期系列报道', '“人民至上、生命至上”主题实践活动 发挥气象防灾减灾第一道防线作用', '“人民至上、生命至上”主题实践活动•先锋', '“十五五“气象高质量发展怎么干', '“十五五”开好局起好步', '“扎实做好防灾救灾各项工作”系列评论', '“打赢‘七下八上’防汛救灾硬仗”系列评论', '“气象+”赋能经济社会高质量发展', '亲历者记忆', '党建纵览', '农业气候资源普查和区划•看试点', '古韵廉心•清风悟语 | 丹心话廉', '名士观点', '天气观察站', '守正创新 奉献气象•弘扬新时代科学家精神主题实践活动典型案例', '总书记的关切•落地回响', '权威发布', '树立和践行正确政绩观•学典型', '环球视线', '科技资源科普化', '聚焦气象科技活动周', '能源气象服务适用技术成果', '记者观察', '谈天说“理”', '践行“观测及服务”理念 赋能气象服务提质增效', '地方领导谈气象', '高质量发展中国行 新时代的气象万千', '强化政治机关意识 走好第一方阵•一线答卷', '聚焦北方地区极端天气防御能力建设', '清廉气象', '千乡万村气象科普行', '微话题', '云海', '中国气象智能预警方案“妈祖”']


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
    # bar_text 至少要包含标准栏目名，避免用空泛描述伪造“看见栏目条”。
    return _column_key(column) in _column_key(bar_text)


PROMPT_TEMPLATE = """这是中国气象报{date}的{page_label}版面图。请严格依据图中实际可见的栏目条，识别栏目条及其正下方的文章。

已知栏目库（只能用其中的标准名称；栏目库只是命名白名单，不能作为图中存在该栏目的依据）：
{known_cols}

硬规则（必须遵守）：
1. 先看图确认真实的栏目条：它是承载栏目名称的短条/横幅，通常有底色、边框或明确的独立版式，并位于一组文章或整版内容上方。只要确实是栏目条，即使浅色、小字号、窄条也不能漏掉。
2. 只有在本期版面图中确实看见栏目条，才允许输出栏目；绝不能因文章标题、正文主题、版面名、历史上出现过，或已知栏目库中存在该名称而猜测。
3. 文章标题、引题、副题、导读、报头、报眉、正文、图片说明、普通装饰性小标签不是栏目条。不要把“看起来像栏目名”的文字当作栏目条，除非图中有明确的栏目条版式。
4. 如果看见的栏目条文字对应已知栏目库，`column` 必须逐字使用库中的标准名称；禁止近义替换、主题推断、最长子串匹配或把相似名称强行对齐。
5. 整版刊头只有在图中确实可见且明确承担栏目标题时，才按其实际覆盖范围归属文章；不能仅凭策划版/专题版的类型自动覆盖。
6. 栏目条下方文章的归属必须依据版面位置和版块边界；看不清或不能确定就不归属。标题必须来自清单原文。
7. 栏目条证据必须写入 `bar_text`（抄录图中看到的栏目条文字），并将 `bar_visible` 设为 true；不能用模型猜出的栏目名代替证据。

请只输出JSON数组，每项格式为：
{"column":"已知栏目库中的标准名称","bar_visible":true,"bar_text":"图中栏目条原文","articles":["该栏目条正下方的标题原文"]}

看不见明确栏目条时返回 []。不要解释。"""


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
    """视觉结果 → API 文章的栏目归属"""
    results = []
    for guid_title in api_articles:
        guid, title = guid_title
        detected = ""
        for col_data in vision_data:
            # 只接受带有当前版面栏目条证据、且严格命中 KNOWN_COLS 的记录。
            if not is_grounded_claim(col_data):
                continue
            col = normalize_col(col_data.get("column"))
            if fuzzy_title_match(title, col_data["articles"]):
                detected = col
                break
        # 注：不做"整版只有一个栏目则全部归入"的兜底——
        # 局部栏目条（如某版只有一处"短讯速递"）会把无关文章误归入；
        # 整版统一栏目时 vision 的 articles 已含全部标题，fuzzy 匹配即可命中。
        results.append({"guid": guid, "title": title, "detected_column": detected})
    return results


def run_vision(img_path, date_str, bc, page_label):
    """输出 prompt 供调用者用 vision_analyze 处理"""
    cols_text = ", ".join(KNOWN_COLS)  # 完整白名单；不得因截断导致已知栏目漏选
    prompt = PROMPT_TEMPLATE.format(
        date=date_str, page_label=page_label, known_cols=cols_text
    )
    vision_json = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
    print(f"\n  >>> 请用 vision_analyze 处理:")
    print(f"  图片: {img_path}")
    print(f"  结果保存到: {vision_json}")
    print(f"  格式: [{{\"column\": \"库内标准栏目名\", \"bar_visible\": true, \"bar_text\": \"图中栏目条原文\", \"articles\": [\"标题1\", ...]}}]")
    return vision_json


def evaluate(date_str, bc, results):
    page = PAGE_LABELS.get(bc, bc)
    print(f"\n{'='*70}")
    print(f"{page}")
    print(f"{'='*70}")
    for i, r in enumerate(results):
        order = f"{i+1:02d}"
        det_col = r["detected_column"]
        print(f"  {order} {r['title'][:28]:30s} 栏目={det_col[:20] or '(空)'}")


def main():
    if hasattr(sys.stdout, "buffer") and sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        import io as _io
        sys.stdout = _io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if len(sys.argv) < 2:
        print("用法: python3 column_detect.py YYYYMMDD [BC]")
        sys.exit(1)
    date_str = sys.argv[1]
    bcs = [sys.argv[2]] if len(sys.argv) > 2 else ["01", "02", "03", "04"]
    os.makedirs(OUT_DIR, exist_ok=True)

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
            # 审核完成：删除版面图（视觉结果已存 _vision.json，图可随时从 epaper 重新下载）
            if img_path and os.path.exists(img_path):
                os.remove(img_path)
                print(f"  [ok] 已删除版面图 {os.path.basename(img_path)}")
        else:
            run_vision(img_path, date_str, bc, page)


if __name__ == "__main__":
    main()
