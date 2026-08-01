#!/usr/bin/env python3
"""根据正文用 LLM 提取 region（地区），跳过已填写的"""

import os, re, json, subprocess, sys, time

OUT_BASE = os.environ.get("CMNRAG_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cmnrag"))
API_BASE = "https://opencode.ai/zen/go/v1/chat/completions"

_PROV = {"郑州市":"河南省郑州市","哈尔滨市":"黑龙江省哈尔滨市","长春市":"吉林省长春市","沈阳市":"辽宁省沈阳市",
         "济南市":"山东省济南市","南京市":"江苏省南京市","杭州市":"浙江省杭州市","福州市":"福建省福州市",
         "广州市":"广东省广州市","南宁市":"广西壮族自治区南宁市","昆明市":"云南省昆明市",
         "贵阳市":"贵州省贵阳市","成都市":"四川省成都市","长沙市":"湖南省长沙市","武汉市":"湖北省武汉市",
         "南昌市":"江西省南昌市","合肥市":"安徽省合肥市","太原市":"山西省太原市","石家庄市":"河北省石家庄市",
         "郑州市":"河南省郑州市","西安市":"陕西省西安市","兰州市":"甘肃省兰州市","西宁市":"青海省西宁市",
         "银川市":"宁夏回族自治区银川市","乌鲁木齐市":"新疆维吾尔自治区乌鲁木齐市","拉萨市":"西藏自治区拉萨市",
         "呼和浩特市":"内蒙古自治区呼和浩特市","北京市":"北京市","上海市":"上海市","天津市":"天津市","重庆市":"重庆市"}

def get_key():
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if "OPENCODE_GO_API_KEY" in line:
                    return line.split("=",1)[1].strip()
    return os.environ.get("OPENCODE_GO_API_KEY")

def llm_region(title, body):
    key = get_key()
    if not key:
        return ""
    prompt = f"文章标题：{title}\n正文开头：{body[:1500]}\n\n判断这篇文章聚焦哪个地区的工作：\n1) 聚焦某地→输出完整行政路径（省+市+县，如\"河南省郑州市\"）\n2) 举例提到的地名不算，要看全文主体聚焦哪个地区\n3) 跨多省或是全国性→输出全国\n只输出地名或全国，不要解释。\n回答："
    cmd = [
        "curl", "-s", "--connect-timeout", "10", "--max-time", "30",
        "-H", f"Authorization: Bearer {key}",
        "-H", "Content-Type: application/json",
        "-d", json.dumps({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 500,
        }),
        API_BASE,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
        if r.returncode != 0:
            return ""
        data = json.loads(r.stdout)
        msg = data.get("choices", [{}])[0].get("message", {})
        content = msg.get("content", "").strip()
        if content == "全国":
            return ""
        if content and not any(kw in content for kw in ["无法","不明确","不聚焦"]):
            result = content
        else:
            result = ""
        if not result:
            raw = msg.get("reasoning_content", "")
            for pat in [r"答[：:]\s*([\u4e00-\u9fff]+(?:省|自治区|市|区|县|自治州))"]:
                m2 = re.search(pat, raw)
                if m2:
                    result = m2.group(1)
                    break
        # 补全省/市前缀
        if result and not re.search(r'^(?:北京|上海|天津|重庆|[\u4e00-\u9fff]{2,}(?:省|自治区))', result):
            for k, v in _PROV.items():
                if result == k or result == k.replace("市",""):
                    result = v
                    break
        return "" if result in ("全国","") else result
    except Exception:
        return ""

def main(date_str):
    base = f"{OUT_BASE}/{date_str[:6]}/{date_str}"
    if not os.path.isdir(base):
        print(f"目录不存在: {base}")
        return
    for page in sorted(os.listdir(base)):
        page_dir = os.path.join(base, page)
        if not os.path.isdir(page_dir):
            continue
        for f in sorted(os.listdir(page_dir)):
            if not f.endswith(".md") or f.startswith("00-"):
                continue
            fpath = os.path.join(page_dir, f)
            with open(fpath, encoding="utf-8") as fh:
                c = fh.read()
            region_match = re.search(r'^region:[ \t]*(.+)$', c, re.MULTILINE)
            if region_match and region_match.group(1).strip():
                continue
            parts = c.split("---", 2)
            if len(parts) < 3:
                continue
            fm_text = parts[1]
            body_text = parts[2].strip()
            title_match = re.search(r'^title:\s*(.+)$', fm_text, re.MULTILINE)
            title = title_match.group(1).strip() if title_match else ""
            if not body_text or not title:
                continue
            region = llm_region(title, body_text[:1500])
            if region:
                c = re.sub(r'^region:\s*$', f"region: {region}", c, flags=re.MULTILINE)
                with open(fpath, "w", encoding="utf-8") as fh:
                    fh.write(c)
            prefix = f.split("-",1)[0]
            print(f"  {page} {prefix}: region={region or '(空)'}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 enrich_regions.py YYYYMMDD")
        sys.exit(1)
    main(sys.argv[1])
