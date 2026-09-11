#!/usr/bin/env python3
"""region（地区）字段：脚本只做清单输出与确定性写入，判读由当前 LLM 执行。

脚本内不含任何模型调用（无 API 端点、无模型名、无 key 读取）。

用法:
  python scripts/enrich_regions.py YYYYMMDD                  # 输出待判清单 JSON
  python scripts/enrich_regions.py --apply YYYYMMDD [JSON]   # 回写判读结果

清单（cmnrag/column_test/YYYYMMDD_regions.json）每条:
  {"key": "一版/01", "page": "一版", "file": "01-xxx.md", "title": "...",
   "excerpt": "正文开头", "region": ""}
当前 LLM 读正文后填写 region：聚焦某地 → 省级开头的完整行政路径（如"广西壮族自治区百色市乐业县"）；
全国性/跨省/中国以外 → 留空；举例提到的地名不算，看全文主体。
--apply 只写 region 仍为空的稿件，已有值一律保留（不覆盖审核结果）。
数据根默认仓库内 cmnrag/，可用 CMNRAG_DATA_DIR 覆盖。
"""
import os, re, json, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BASE = os.environ.get("CMNRAG_DATA_DIR", os.path.join(ROOT, "cmnrag"))
OUT_DIR = os.path.join(OUT_BASE, "column_test")
PAGE_ORDER = ["一版", "二版", "三版", "四版"]

sys.path.insert(0, os.path.join(ROOT, "scripts"))
from column_detect import (_frontmatter_bounds, _frontmatter_field,
                           _replace_list_field_text, validate_frontmatter_tree)

# 完整性校验：region 必须是省级行政区开头的完整路径，缺省级前缀一律拒绝写入。
PROVINCE_RE = re.compile(r'^(?:北京|上海|天津|重庆|[\u4e00-\u9fff]{2,}(?:省|自治区|特别行政区))')


def checklist_path(date_str):
    return os.path.join(OUT_DIR, f"{date_str}_regions.json")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _page_sort_key(page):
    return (PAGE_ORDER.index(page) if page in PAGE_ORDER else 99, page)


def collect(date_str):
    """收集 region 仍为空的稿件；已填值一律跳过。"""
    base = os.path.join(OUT_BASE, date_str[:6], date_str)
    items = []
    if not os.path.isdir(base):
        return items
    for page in sorted(os.listdir(base), key=_page_sort_key):
        page_dir = os.path.join(base, page)
        if not os.path.isdir(page_dir):
            continue
        for name in sorted(os.listdir(page_dir)):
            if not name.endswith(".md") or name.startswith("00-"):
                continue
            text = _read(os.path.join(page_dir, name))
            lines = text.splitlines(keepends=True)
            bounds = _frontmatter_bounds(lines)
            if not bounds:
                continue
            start, end = bounds
            _, inline, items_region = _frontmatter_field(lines, start, end, "region")
            if inline or items_region:  # 已有值（含标量）→ 不覆盖
                continue
            _, title, _ = _frontmatter_field(lines, start, end, "title")
            parts = text.split("---", 2)
            body = parts[2].strip() if len(parts) == 3 else ""
            order = re.match(r"\d+", name)
            items.append({
                "key": f"{page}/{order.group() if order else name[:2]}",
                "page": page,
                "file": name,
                "title": title or "",
                "excerpt": re.sub(r"\s+", " ", body)[:300],
                "region": "",
            })
    return items


def main(date_str):
    items = collect(date_str)
    if not items:
        print("没有待判地区的稿件（region 均已填写或目录不存在）")
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    path = checklist_path(date_str)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    print(f"待判地区 {len(items)} 篇 -> {path}")
    for item in items:
        print(f"  {item['key']}  {item['title'][:34]}")
        print(f"        {item['excerpt'][:110]}")
    print("\n下一步：当前 LLM 读正文填写 region（省级开头的完整路径；不聚焦具体地区留空），再运行")
    print(f"  python scripts/enrich_regions.py --apply {date_str}")


def apply_regions(date_str, path=None):
    path = path or checklist_path(date_str)
    if not os.path.exists(path):
        print(f"错误: 清单不存在 {path}")
        sys.exit(1)
    with open(path, encoding="utf-8") as f:
        items = json.load(f)
    base = os.path.join(OUT_BASE, date_str[:6], date_str)
    updated = skipped = failed = 0
    for item in items:
        value = str(item.get("region") or "").strip()
        if not value:
            skipped += 1
            continue
        parts = [v.strip() for v in re.split(r"[;；]", value) if v.strip()]
        bad = [v for v in parts if not PROVINCE_RE.match(v)]
        if bad:
            print(f"  [x] {item.get('key')} 地区缺少省级前缀，未写入: {'、'.join(bad)}")
            failed += 1
            continue
        fpath = os.path.join(base, str(item.get("page") or ""), str(item.get("file") or ""))
        if not os.path.exists(fpath):
            print(f"  [x] {item.get('key')} 找不到稿件: {item.get('file')}")
            failed += 1
            continue
        text = _read(fpath)
        lines = text.splitlines(keepends=True)
        bounds = _frontmatter_bounds(lines)
        if not bounds:
            print(f"  [x] {item.get('file')} 缺少合法 frontmatter")
            failed += 1
            continue
        start, end = bounds
        _, inline, items_region = _frontmatter_field(lines, start, end, "region")
        if inline or items_region:
            print(f"  [保留] {item.get('file')} 已有 region，未覆盖")
            skipped += 1
            continue
        new_text = _replace_list_field_text(text, "region", parts)
        if new_text != text:
            with open(fpath, "w", encoding="utf-8", newline="") as f:
                f.write(new_text)
            updated += 1
            print(f"  [ok] {item.get('key')} {parts[0]}")
    print(f"\n地区写入 {updated} 篇"
          + (f"，跳过 {skipped} 篇" if skipped else "")
          + (f"，失败 {failed} 篇" if failed else ""))
    if not validate_frontmatter_tree(date_str, ["01", "02", "03", "04"]):
        sys.exit(2)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print("用法: python scripts/enrich_regions.py YYYYMMDD")
        print("      python scripts/enrich_regions.py --apply YYYYMMDD [JSON]")
        sys.exit(1)
    if args[0] == "--apply":
        if len(args) < 2:
            print("用法: python scripts/enrich_regions.py --apply YYYYMMDD [JSON]")
            sys.exit(1)
        apply_regions(args[1], args[2] if len(args) > 2 else None)
    else:
        main(args[0])
