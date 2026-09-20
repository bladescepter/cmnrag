# 中国气象报 epaper API 参考

## 基础 URL
`http://epaper.zgqxb.com.cn/`

## 日期范围
网站仅保留**近1年**的报纸数据（从当前日期倒推）。

## 接口详情

### 1. 获取某月出版日期
**POST** `/reader/layout/getSZBDate.do`

参数：`sj=2026-07`

返回：`["2026-07-01","2026-07-02","2026-07-03",...]`（有出版的日期列表）

### 2. 获取指定日期的版面菜单
**POST** `/reader/layout/findBmMenu.do`

参数：`docPubTime=20260722`

返回示例：
```json
[
  {
    "ID": "20260722_01",
    "BC": "第01版",
    "BM": "要闻",
    "BM_JPG_URL": {
      "JPPATH_BZT": "group1/M00/05/E8/CgBB-Wpf_dGARZgZADTMkFAAuWk648.jpg",
      "JPPATH_ZT": "group1/M00/05/E8/CgBB-Wpf_dGAVKY4AB_UtQsUjsQ971.jpg"
    },
    "PDPATH": "group1/M00/05/E8/CgBB-Wpf_dGAL_cXACPjtgjHa7A279.pdf",
    "IRCATELOG": "01",
    "NUM": 0
  },
  ...
]
```
- `BC`: 版面中文名（如"第01版"）
- `BM`: 版面栏目名（如"要闻""综合""党建""和美乡村"）
- `BM_JPG_URL.JPPATH_BZT`: 版面预览图（小图）
- `BM_JPG_URL.JPPATH_ZT`: 版面大图（用于视觉识别）
- `PDPATH`: PDF下载路径
- `IRCATELOG`: 版面编号（01/02/03/04）

图片/PDF基础路径：`http://epaper.zgqxb.com.cn/group1/...`

### 3. 获取某版文章列表
**POST** `/reader/layout/getBmDetail.do`

参数：`bc=01&docpubtime=2026/07/22`

- `bc`: 版面编号（01/02/03/04）
- `docpubtime`: 日期，Y/m/d 格式

返回关键字段：
- `DOCTITLE`: 文章标题
- `DOCAUTHOR`: 作者
- `TXS`: 字数
- `BM`: 版面名
- `ZB_GUID`: 文章唯一ID（用于获取全文）
- `ZB`: 版面坐标百分比字符串（用于定位文章在版面上的位置）
- `JPPATH`: 所在版面图

### 4. 获取文章全文
**POST** `/reader/layout/detailData.do`

参数：`guid={ZB_GUID}`

返回示例：
```json
{
  "docTitle": "标题",
  "docAuthor": "作者",
  "txs": "1512",
  "yt": "引题",
  "fb": "副题",
  "docPubTime": "2026/07/22 00:00:00",
  "content": "正文HTML（含&nbsp;&nbsp;和\\n）",
  "ctpath": "配图路径1;配图路径2",
  "ts": "图说1;null",
  "bc": "01"
}
```

- `yt`: 引题（如无则为空）
- `fb`: 副题（如无则为空）
- `content`: 正文，含 `&nbsp;&nbsp;`（缩进）和 `\n`（段落）
- `ctpath`: 配图路径，分号 `;` 分隔，若为空则无配图
- `ts`: 图片说明，分号 `;` 分隔，`null` 表示无说明

## 正文清洗模板
```python
import re
content = content.replace('&nbsp;&nbsp;', ' ')  # 缩进转空格
content = re.sub(r'<[^>]+>', '', content)        # 去HTML标签
content = content.strip()
```

## 版面对应关系（7月22日示例）
| IRCATELOG | 版面 | 文章数 |
|-----------|------|--------|
| 01 | 第01版·要闻 | 8 |
| 02 | 第02版·综合 | 11 |
| 03 | 第03版·党建 | 5 |
| 04 | 第04版·和美乡村 | 5 |
