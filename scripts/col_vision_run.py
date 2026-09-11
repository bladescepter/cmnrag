#!/usr/bin/env python3
"""栏目识别准备器：取版面图并产出裁剪放大图，由当前 LLM 读图识别栏目。

脚本内不含任何模型调用（无 API 端点、无模型名、无 key 读取）：只做确定性的
"下载版面图 + 整版缩放 + 横向条带放大"，并把识别任务与输出契约打印给当前 LLM。

用法:
  python scripts/col_vision_run.py YYYYMMDD [BC]...   # 准备图片并打印识别任务
  python scripts/col_vision_run.py --validate YYYYMMDD [BC]...
                                                     # 校验已写好的 vision.json

产物（cmnrag/column_test/）:
  YYYYMMDD_BC.jpg           整版原图（column_detect.py 已下载则复用）
  YYYYMMDD_BC_full.jpg      整版等比缩放（宽 1600，通览版面结构）
  YYYYMMDD_BC_band0..3.jpg  横向条带放大（顶部通栏 / 中部上 / 中部下 / 版底，全宽不切列）
  YYYYMMDD_BC_col0..2.jpg   纵向列条放大（左列 / 中列 / 右列，带重叠；看窄栏与竖排通栏）
  YYYYMMDD_BC_vision.json   当前 LLM 识别结果（本脚本 --validate 校验）

vision.json 格式（栏标是唯一证据，栏目名必须逐字命中 KNOWN_COLS）:
  [{"column": "库内标准栏目名", "bar_visible": true, "bar_text": "图中栏目条原文",
    "articles": ["标题原文1", "标题原文2"]}]

识别完成后运行 python scripts/column_detect.py YYYYMMDD 匹配并写入 column。
历史栏目"存在过"不能证明本期存在；条带扫描没看到也不等于不存在。
"""
import os, json, sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from column_detect import (OUT_DIR, PAGE_LABELS, KNOWN_COLS, get_page_data,
                           download_image, is_grounded_claim, normalize_col)

# 横向条带（全宽不切列；带重叠，避免把横幅栏目条切断）
BANDS = [(0.00, 0.34, "顶部通栏"), (0.30, 0.62, "中部上"),
         (0.58, 0.84, "中部下"), (0.80, 1.00, "版底")]
# 纵向列条（带重叠；用于看清窄栏/竖排通栏/版底短讯栏的分块边界）
COLS = [(0.00, 0.40, "左列"), (0.35, 0.75, "中列"), (0.70, 1.00, "右列")]

RULES = [
    "栏标是唯一证据：只认图中实际可见、承担栏目名称的短条/横幅（带底色、边框或独立版式都算）。",
    "浅色、小字号、窄条只要确实是栏目条也必须识别，不设醒目度门槛。",
    "文章标题/引题/副题/导读/报头/报眉/正文/图片说明/普通装饰文字都不是栏目证据。",
    "栏目名必须逐字命中 KNOWN_COLS；禁止近义替换、主题推断、相似度或最长子串对齐。",
    "库外文字不得强行映射为库内栏目；确为栏条时记录原文供审核。",
    "整版刊头只有在图中确实可见且承担栏目标题时，才按实际版块边界归属文章。",
    "归属只看版面位置：栏条正下方、同属一个版块的文章；不确定就不归属。",
    "常规版大部分文章无栏目条，覆盖数 < 文章数属正常；但图上可见的栏条不得漏填。",
]


def _save_scaled(img, out_path, max_w):
    im = img.copy()
    if im.width > max_w:
        im = im.resize((max_w, int(im.height * max_w / im.width)), Image.LANCZOS)
    im.convert("RGB").save(out_path, "JPEG", quality=90)
    return out_path


def prepare_page(date_str, bc):
    """下载整版图 + 产出整版缩放与 4 条带放大图，返回 (page, titles, images)。"""
    page = PAGE_LABELS.get(bc, bc)
    data = get_page_data(date_str, bc)
    if not data:
        print(f"[!] {page} 无法获取版面数据")
        return None
    img_path = download_image(data["jppath"], date_str, bc)
    if not img_path:
        print(f"[!] {page} 无法下载版面图")
        return None
    titles = [a["DOCTITLE"] for a in data["articles"] if a.get("DOCTITLE")]
    images = [("整版缩放", _save_scaled(Image.open(img_path), os.path.join(OUT_DIR, f"{date_str}_{bc}_full.jpg"), 1600))]
    for i, (y0, y1, label) in enumerate(BANDS):
        im = Image.open(img_path).convert("RGB")
        W, H = im.size
        crop = im.crop((0, int(H * y0), W, int(H * y1)))
        out = os.path.join(OUT_DIR, f"{date_str}_{bc}_band{i}.jpg")
        _save_scaled(crop, out, 1400)
        images.append((f"{label}（y {y0:.2f}-{y1:.2f}）", out))
    for i, (x0, x1, label) in enumerate(COLS):
        im = Image.open(img_path).convert("RGB")
        W, H = im.size
        crop = im.crop((int(W * x0), 0, int(W * x1), H))
        out = os.path.join(OUT_DIR, f"{date_str}_{bc}_col{i}.jpg")
        _save_scaled(crop, out, 1400)
        images.append((f"{label}（x {x0:.2f}-{x1:.2f}）", out))
    return page, titles, images


def prepare(date_str, bcs):
    for bc in bcs:
        result = prepare_page(date_str, bc)
        if not result:
            continue
        page, titles, images = result
        print(f"\n{'=' * 70}")
        print(f"{date_str} {page}（{len(titles)} 篇文章）")
        print(f"{'=' * 70}")
        print("本版文章标题清单（归属映射用；标题不是栏目证据）：")
        for i, t in enumerate(titles, 1):
            print(f"  {i:02d}. {t}")
        print("\n识别用图片（当前 LLM 直接读图，逐张都看）：")
        for label, path in images:
            print(f"  [{label}] {path}")
        print(f"\n判别规则：")
        for rule in RULES:
            print(f"  · {rule}")
        print(f"\n栏目库（命名白名单，不是图中存在栏目的证据）：")
        print("  " + "、".join(KNOWN_COLS))
        print(f"\n输出：写 {os.path.join(OUT_DIR, f'{date_str}_{bc}_vision.json')}，格式：")
        print('  [{"column": "库内标准栏目名", "bar_visible": true, "bar_text": "图中栏目条原文", "articles": ["标题原文"]}]')
        print(f"  本版没有明确栏目条就写 []。")
    print(f"\n写完后自检：python scripts/col_vision_run.py --validate {date_str} " + " ".join(bcs))
    print(f"再匹配写入：python scripts/column_detect.py {date_str}")


def validate(date_str, bcs):
    """用 column_detect 的同一套证据校验规则检查已写好的 vision.json。"""
    exit_code = 0
    for bc in bcs:
        page = PAGE_LABELS.get(bc, bc)
        path = os.path.join(OUT_DIR, f"{date_str}_{bc}_vision.json")
        if not os.path.exists(path):
            print(f"[!] {page} 缺少 {os.path.basename(path)}")
            exit_code = 2
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            print(f"[x] {page} vision.json 不是 JSON 数组")
            exit_code = 2
            continue
        kept, dropped = [], []
        for item in data:
            (kept if is_grounded_claim(item) else dropped).append(item)
        print(f"\n{page}：有效 {len(kept)} 条，丢弃 {len(dropped)} 条")
        for item in kept:
            cols = normalize_col(item.get("column"))
            print(f"  [ok] 「{cols}」 bar_text={item.get('bar_text')!r} 归属 {len(item.get('articles') or [])} 篇")
        for item in dropped:
            print(f"  [x] 丢弃（无栏条证据/库外栏目名）: {json.dumps(item, ensure_ascii=False)[:160]}")
            exit_code = 2
    return exit_code


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: python scripts/col_vision_run.py YYYYMMDD [BC]...")
        print("      python scripts/col_vision_run.py --validate YYYYMMDD [BC]...")
        sys.exit(1)
    validating = args[0] == "--validate"
    if validating:
        args = args[1:]
    if not args:
        print("用法: python scripts/col_vision_run.py [--validate] YYYYMMDD [BC]...")
        sys.exit(1)
    date_str = args[0]
    bcs = [a for a in args[1:] if a in PAGE_LABELS] or ["01", "02", "03", "04"]
    os.makedirs(OUT_DIR, exist_ok=True)
    if validating:
        sys.exit(validate(date_str, bcs))
    prepare(date_str, bcs)


if __name__ == "__main__":
    main()
