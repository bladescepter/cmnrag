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

KNOWN_COLS = [
    "短讯速递", '"人民至上、生命至上"主题实践活动', "科普看台", "气象博观",
    "党旗在基层一线高高飘扬", "科技视野", "汛期气象科技支撑系列报道", "气象观天下",
    '"气象+"赋能经济社会高质量发展', "振兴 乡村小而美",
    '"十五五"开好局起好步', "时评", "权威解读",
    "领略 国际气象发展前沿", "党旗在防汛一线飘扬",
    "强化政治机关意识 走好第一方阵", "总书记的关切", "我在现场",
    "树立和践行正确政绩观", "漫评", "科普一读", "要闻简报",
    '"七下八上"防汛关键期系列报道', "守正创新 奉献气象",
    "强化政治机关意识 走好第一方阵•学思践悟", "编辑点评", '谈天说"理"',
    "高质量发展中国行", '"十五五"气象高质量发展怎么干', "双碳行动",
    "古韵廉心•清风悟语", "国际天气观察站", "在希望的田野上", "安全生产",
    "气象服务领域数据流通安全治理典型案例", "深度调研", "锋评",
    '"扎实做好防灾救灾各项工作"系列评论',
    '"打赢七下八上防汛救灾硬仗"系列评论',
    "强化政治机关意识 走好第一方阵•评论", "强化政治机关意识 走好第一方阵•榜样力量",
    "我和天气打交道", "春雨日记",
    "气象科技能力现代化 社会服务现代化•科技创新",
    "气象科技能力现代化 社会服务现代化•解码气象科技",
    '"人民至上、生命至上"主题实践活动•先锋',
    "强化政治机关意识 走好第一方阵",
    "\u201c七下八上\u201d防汛关键期系列报道",
    "\u201c人民至上、生命至上\u201d主题实践活动 发挥气象防灾减灾第一道防线作用",
    "\u201c人民至上、生命至上\u201d主题实践活动•先锋",
    "\u201c十五五\u201c气象高质量发展怎么干",
    "\u201c十五五\u201d开好局起好步",
    "\u201c扎实做好防灾救灾各项工作\u201d系列评论",
    "\u201c打赢‘七下八上’防汛救灾硬仗\u201d系列评论",
    "\u201c气象+\u201d赋能经济社会高质量发展",
    "亲历者记忆", "党建纵览", "农业气候资源普查和区划•看试点",
    "古韵廉心•清风悟语 | 丹心话廉", "名士观点", "天气观察站",
    "守正创新 奉献气象•弘扬新时代科学家精神主题实践活动典型案例",
    "总书记的关切•落地回响", "权威发布", "树立和践行正确政绩观•学典型",
    "气象科技能力现代化 社会服务现代化•解码气象科技 中国气象科学研究院协办",
    "环球视线", "科技资源科普化", "聚焦气象科技活动周", "能源气象服务适用技术成果",
    "记者观察", "谈天说\u201c理\u201d",
    "践行\u201c观测及服务\u201d理念 赋能气象服务提质增效",
    "领略 国际气象发展前沿 中国气象局气象发展与规划院协办",
    "高质量发展中国行 新时代的气象万千",
]

PROMPT_TEMPLATE = """这是中国气象报{date}的{page_label}。请识别版面上的栏目条及其下方的文章。

已知栏目列表（只能从这个列表中选择栏目名，尽量匹配）：
{known_cols}

规则：
1. 栏目条是带底色、线框或特殊样式的标识，位于整版或一组文章上方
2. 如果整版顶部有一个大的统一栏目条，所有文章都属于这个栏目
3. 不要把文章标题、引题、副标题、导读当作栏目条
4. 每篇文章标题请尽量完整读取（至少15字）

请输出JSON数组，每项包含：
- column: 栏目名称（从列表中选）
- articles: 该栏目下方的文章标题列表

如果没有栏目条，返回空数组。只输出JSON，不要解释。"""


def curl_post(url, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", "--connect-timeout", "5", "--max-time", "15", url, "-d", data],
        capture_output=True, text=True, timeout=20
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


def get_gold_standard(date_str, bc):
    month = date_str[:6]
    page = PAGE_LABELS.get(bc, "")
    base = os.path.join(os.environ.get("CMNRAG_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmnrag")), month, date_str, page)
    if not os.path.isdir(base): return {}
    result = {}
    for f in sorted(os.listdir(base)):
        if not f.endswith(".md"): continue
        c = open(os.path.join(base, f), encoding="utf-8").read()
        order = f.split("-")[0]
        col = title = ""
        for line in c.split("\n"):
            if line.startswith("column:"): col = line.split(":", 1)[1].strip()
            if line.startswith("title:"): title = line.split(":", 1)[1].strip()
        result[order] = {"column": col, "title": title}
    return result


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


def col_match(detected, gold_col):
    if not detected and not gold_col: return True
    if not detected or not gold_col: return False
    d, g = normalize(detected), normalize(gold_col)
    for n in [4, 6, 8]:
        if len(d) >= n and len(g) >= n:
            if d[:n] in g or g[:n] in d: return True
    return False


def match_columns(vision_data, api_articles):
    """视觉结果 → API 文章的栏目归属"""
    results = []
    for guid_title in api_articles:
        guid, title = guid_title
        detected = ""
        for col_data in vision_data:
            if fuzzy_title_match(title, col_data["articles"]):
                detected = col_data["column"]
                break
        # 整版只有一个栏目条时，未匹配文章自动归入
        if not detected and len(vision_data) == 1:
            detected = vision_data[0]["column"]
        results.append({"guid": guid, "title": title, "detected_column": detected})
    return results


def run_vision(img_path, date_str, bc, page_label):
    """输出 prompt 供调用者用 vision_analyze 处理"""
    cols_text = ", ".join(KNOWN_COLS[:30])  # 限制长度避免 prompt 过长
    prompt = PROMPT_TEMPLATE.format(
        date=date_str, page_label=page_label, known_cols=cols_text
    )
    vision_json = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
    print(f"\n  >>> 请用 vision_analyze 处理:")
    print(f"  图片: {img_path}")
    print(f"  结果保存到: {vision_json}")
    print(f"  格式: [{{\"column\": \"栏目名\", \"articles\": [\"标题1\", ...]}}]")
    return vision_json


def evaluate(date_str, bc, results, gold):
    page = PAGE_LABELS.get(bc, bc)
    print(f"\n{'='*70}")
    print(f"{page}")
    print(f"{'='*70}")
    correct = 0
    for i, r in enumerate(results):
        order = f"{i+1:02d}"
        gold_col = gold.get(order, {}).get("column", "")
        det_col = r["detected_column"]
        if col_match(det_col, gold_col):
            correct += 1; status = "✅"
        else:
            status = "❌"
        print(f"  {order} {r['title'][:28]:30s} 检测={det_col[:20] or '(空)':22s} 金标={gold_col[:20] or '(空)':22s} {status}")
    acc = correct / len(results) * 100 if results else 0
    print(f"  准确率: {correct}/{len(results)} ({acc:.1f}%)")
    return correct, len(results)


def main():
    if len(sys.argv) < 2:
        print("用法: python3 column_detect.py YYYYMMDD [BC]")
        sys.exit(1)
    date_str = sys.argv[1]
    bcs = [sys.argv[2]] if len(sys.argv) > 2 else ["01", "02", "03", "04"]
    os.makedirs(OUT_DIR, exist_ok=True)

    total_correct = total_count = 0
    for bc in bcs:
        page = PAGE_LABELS.get(bc, bc)
        data = get_page_data(date_str, bc)
        if not data:
            print(f"⚠ 无法获取 {page} 数据")
            continue
        img_path = download_image(data["jppath"], date_str, bc)
        if not img_path:
            print(f"⚠ 无法下载 {page} 图片")
            continue
        print(f"\n{date_str} {page}: {len(data['articles'])} 篇文章")

        vision_json = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
        if os.path.exists(vision_json):
            vision_data = json.load(open(vision_json, encoding="utf-8"))
            api_articles = [(a["ZB_GUID"], a["DOCTITLE"]) for a in data["articles"]]
            results = match_columns(vision_data, api_articles)
            gold = get_gold_standard(date_str, bc)
            c, t = evaluate(date_str, bc, results, gold)
            total_correct += c; total_count += t
            # 保存结果
            out_path = os.path.join(OUT_DIR, f"{date_str}_{bc}_result.json")
            json.dump(results, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        else:
            run_vision(img_path, date_str, bc, page)

    if total_count > 0:
        print(f"\n{'='*70}")
        print(f"总计: {total_correct}/{total_count} ({total_correct/total_count*100:.1f}%)")
        if total_correct / total_count * 100 >= 95:
            print("✅ 达到 95% 准确率")
        else:
            print("❌ 未达到 95%")


if __name__ == "__main__":
    main()
