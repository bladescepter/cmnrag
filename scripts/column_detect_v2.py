#!/usr/bin/env python3
"""
栏标识别试验脚本 v2（离线，不写入正式数据）

改进：
- 视觉模型同时识别栏目条和文章标题位置
- 几何匹配在图片百分比坐标系内完成（不依赖 ZB）
- 排除导读、引题等非栏目元素
- x 重叠要求 ≥30%
"""
import subprocess, json, os, sys

API_BASE = "http://epaper.zgqxb.com.cn/reader/layout"
IMG_BASE = "http://epaper.zgqxb.com.cn"
OUT_DIR = os.environ.get("CMNRAG_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmnrag"))
OUT_DIR = os.path.join(OUT_DIR, "column_test")
PAGE_LABELS = {"01": "一版", "02": "二版", "03": "三版", "04": "四版"}

# 非栏目条的关键词（出现则排除）
EXCLUDE_KEYWORDS = {"导读", "目录", "索引", "今日导读", "报头", "刊名"}

def curl_post(url, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", "--connect-timeout", "5", "--max-time", "15", url, "-d", data],
        capture_output=True, text=True, timeout=20
    )
    if r.returncode != 0: return None
    try: return json.loads(r.stdout)
    except: return None

def get_page_data(date_str, bc):
    date_dash = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    editions = curl_post(f"{API_BASE}/findBmMenu.do", f"docPubTime={date_str}")
    if not editions: return None
    jppath = None
    theme = ""
    for ed in editions:
        if ed.get("IRCATELOG") == bc:
            jppath = ed.get("JPPATH", "")
            theme = ed.get("BM", "")
            break
    if not jppath: return None
    articles = curl_post(f"{API_BASE}/getBmDetail.do", f"bc={bc}&docpubtime={date_dash}")
    if not articles: return None
    return {"jppath": jppath, "theme": theme, "articles": articles,
            "bc": bc, "page": PAGE_LABELS.get(bc, bc)}

def download_page_image(jppath, date_str, bc):
    os.makedirs(OUT_DIR, exist_ok=True)
    local_path = os.path.join(OUT_DIR, f"{date_str}_{bc}.jpg")
    if os.path.exists(local_path): return local_path
    url = f"{IMG_BASE}/{jppath}"
    subprocess.run(["curl", "-s", "-o", local_path, "--connect-timeout", "10", "--max-time", "30", url],
                   capture_output=True, timeout=35)
    if os.path.exists(local_path) and os.path.getsize(local_path) > 1000:
        return local_path
    return None

def get_gold_standard(date_str, bc):
    month = date_str[:6]
    base = os.path.join(os.environ.get("CMNRAG_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmnrag")), month, date_str, PAGE_LABELS.get(bc, ""))
    if not os.path.isdir(base): return {}
    result = {}
    for f in sorted(os.listdir(base)):
        if not f.endswith(".md"): continue
        c = open(os.path.join(base, f), encoding="utf-8").read()
        order = f.split("-")[0]
        col = ""
        title = ""
        for line in c.split("\n"):
            if line.startswith("column:"): col = line.split(":", 1)[1].strip()
            if line.startswith("title:"): title = line.split(":", 1)[1].strip()
        result[order] = {"column": col, "title": title}
    return result

def filter_column_bars(bars):
    """过滤掉非栏目条"""
    result = []
    for bar in bars:
        text = bar.get("text", "")
        if any(kw in text for kw in EXCLUDE_KEYWORDS):
            continue
        result.append(bar)
    return result

def x_overlap_ratio(a_left, a_right, b_left, b_right):
    """计算 x 方向重叠比例（相对于较窄的那个）"""
    overlap = min(a_right, b_right) - max(a_left, b_left)
    if overlap <= 0: return 0
    min_width = min(a_right - a_left, b_right - b_left)
    return overlap / min_width if min_width > 0 else 0

def match_columns(bars, articles):
    """
    几何匹配：栏目条 → 文章
    规则：
    1. 文章 top 在栏目条 bottom 下方（容差 2%）
    2. 文章 top 在下一个栏目条 top 之前
    3. x 重叠 ≥ 30%
    """
    real_bars = sorted(filter_column_bars(bars), key=lambda b: b["top"])
    articles_sorted = sorted(articles, key=lambda a: a["top"])
    
    results = []
    for art in articles_sorted:
        matched_bar = None
        for bar in real_bars:
            # 文章在栏目条下方？
            if art["top"] < bar["bottom"] - 2:
                continue
            # x 重叠 ≥ 30%？
            if x_overlap_ratio(art["left"], art["right"], bar["left"], bar["right"]) < 0.3:
                continue
            # 检查是否有更近的栏目条
            if matched_bar is None or bar["bottom"] > matched_bar["bottom"]:
                # 确保文章在下一个栏目条之前
                next_bar_top = min(
                    (b2["top"] for b2 in real_bars if b2["top"] > bar["bottom"]),
                    default=100
                )
                if art["top"] < next_bar_top:
                    matched_bar = bar
        
        results.append({
            "title": art["title"],
            "detected_column": matched_bar["text"] if matched_bar else "",
            "art_top": art["top"],
            "art_left": art["left"],
            "art_right": art["right"],
        })
    return results

def evaluate(date_str, bc, results, gold):
    page = PAGE_LABELS.get(bc, bc)
    print(f"\n{'='*60}")
    print(f"验证: {date_str} {page}")
    print(f"{'='*60}")
    
    total = correct = pending = 0
    errors = []
    
    # Match results to gold standard by title
    for i, r in enumerate(results):
        order = f"{i+1:02d}"
        # Find matching gold entry
        gold_entry = None
        for o, g in gold.items():
            if r["title"][:10] in g["title"] or g["title"][:10] in r["title"]:
                gold_entry = (o, g)
                break
        if not gold_entry:
            # Try by order
            gold_entry = (order, gold.get(order, {"column": "", "title": r["title"]}))
        
        gold_col = gold_entry[1]["column"]
        det_col = r["detected_column"]
        total += 1
        
        if det_col == gold_col or (not det_col and not gold_col):
            correct += 1
            status = "✅"
        else:
            errors.append((order, r["title"][:20], det_col, gold_col))
            status = "❌"
        
        print(f"  {order} {r['title'][:25]:25s} 检测={det_col or '(空)':20s} 金标={gold_col or '(空)':20s} {status}")
    
    accuracy = correct / total * 100 if total else 0
    print(f"\n准确率: {correct}/{total} ({accuracy:.1f}%)")
    if errors:
        print(f"错误 {len(errors)} 个")
    
    return {"date": date_str, "bc": bc, "total": total, "correct": correct, "accuracy": accuracy}

def main():
    if len(sys.argv) < 2:
        print("用法: python3 column_detect_v2.py YYYYMMDD [BC]")
        sys.exit(1)
    
    date_str = sys.argv[1]
    bcs = [sys.argv[2]] if len(sys.argv) > 2 else ["01", "02", "03", "04"]
    
    os.makedirs(OUT_DIR, exist_ok=True)
    
    for bc in bcs:
        page = PAGE_LABELS.get(bc, bc)
        page_data = get_page_data(date_str, bc)
        if not page_data:
            print(f"⚠ 无法获取 {page} 数据"); continue
        
        img_path = download_page_image(page_data["jppath"], date_str, bc)
        if not img_path:
            print(f"⚠ 无法下载 {page} 图片"); continue
        
        print(f"\n{date_str} {page}: {len(page_data['articles'])} 篇文章")
        print(f"图片: {img_path}")
        
        # Check for vision results
        result_json = os.path.join(OUT_DIR, f"{date_str}_{bc}_v2.json")
        if os.path.exists(result_json):
            vision_data = json.load(open(result_json, encoding="utf-8"))
            bars = vision_data.get("column_bars", [])
            articles = vision_data.get("articles", [])
            
            print(f"\n识别到 {len(bars)} 个栏目条（过滤前）")
            real_bars = filter_column_bars(bars)
            print(f"过滤后 {len(real_bars)} 个栏目条：")
            for b in real_bars:
                print(f"  「{b['text']}」 top={b['top']:.1f}% L={b['left']:.1f}% R={b['right']:.1f}%")
            
            print(f"\n识别到 {len(articles)} 篇文章")
            
            # Match
            results = match_columns(bars, articles)
            
            # Gold standard
            gold = get_gold_standard(date_str, bc)
            
            # Evaluate
            evaluate(date_str, bc, results, gold)
        else:
            print(f"\n⏳ 需要 vision_analyze 结果")
            print(f"图片: {img_path}")
            print(f"保存到: {result_json}")
            print(f"格式: {{\"column_bars\": [...], \"articles\": [...]}}")

if __name__ == "__main__":
    main()
