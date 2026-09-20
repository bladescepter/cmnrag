# 作者提取流程（2026-07-29 最终版）

## 核心原则

**已知作者锚点优先于启发式**（用户明确要求）：已知库中的名字作为锚点保留，未知部分走启发式，不要求全部覆盖。

## 回退顺序

```
1. API docAuthor
   → 去"新华社""本报""本报特约" + "记者""通讯员"前缀
   → 去《其他媒体》记者XXX（如《中国应急管理报》记者张楠）
   → 去残留《》内容
   → 若剩下"下转第三版"等排版信息 → 清空
   → 中间职称清理（同正文提取路径一样）
   → 调用 split_authors() 分词

2. 正文末尾（xx整理）、（XX）、（调研组成员：XX）
   → 编译: （编译[：:]...[\\u4e00-\\u9fff·、]+?)(?:来源|$)
   → 普通姓名: （[\\u4e00-\\u9fff·]{2,}）  re.MULTILINE
   → 调研组: （(?:调研组成员?|作者)[：:][\\u4e00-\\u9fff·、]+)

3. 图片新闻署名
   → re.findall 提取全部 图/XX 去重
   → (?:图|文|制图)/\\s*([\\u4e00-\\u9fff·]{2,4}?)(?=(?:文|图|制图)/|\\n|$)

4. 正文开头 本报讯/本报 + 记者/通讯员 + 姓名

5. 正文首行单独成段的姓名（2-4字兜底）

统一经过 split_authors() 后写入
```

## split_authors() 锚点分割法

### 输入 → 输出

| 输入 | 输出 | 说明 |
|------|------|------|
| `李冬梅高瑶` | `李冬梅 高瑶` | 李冬梅是已知名→锚点；高瑶未知→启发式得"高瑶" |
| `仇彦辉周宇张宁` | `仇彦辉 周宇 张宁` | 仇彦辉已知→锚点，剩余启发式 |
| `谢玉丽吴育锟杨丽慧` | `谢玉丽 吴育锟 杨丽慧` | 谢玉丽已知→锚点 |
| `周宇张宁` | `周宇 张宁` | 都未知→纯启发式 |
| `宋巧云` | `宋巧云` | 3字名，不分 |

### 算法

```python
known_segments = {}  # {位置: 长度}
i = 0
while i < len(part):
    for length in (4, 3, 2):      # 优先长匹配
        seg = part[i:i+length]
        if seg in KNOWN_AUTHORS:
            known_segments[i] = length
            i += length; break
    else: i += 1

# 已知名做锚点，未知段递归 split_authors
for pos in sorted(known_segments):
    if pos > prev_end:
        chunk = split_authors(part[prev_end:pos])  # 递归
        result_parts.append(chunk)
    result_parts.append(part[pos:pos+length])
```

### 启发式（纯未知段用）

```python
SURNAMES = set("赵钱孙李周吴郑王……")  # 百家姓全表
for i, ch in enumerate(part):
    if ch in SURNAMES and i > 1 and i < len(part)-1:
        seg = pieces[-1]   # 最近累积的片段
        if len(seg) >= 3 or (len(seg) == 2 and len(part)-i >= 2):
            pieces.append(' ')  # 分割
```

### 单字过滤

`single_count == 0` 确保已知段不输出单字。但锚点模式下这个条件变为：已知段直接使用，未知段通过启发式处理，无需单字过滤。

## docAuthor 路径特有陷阱

| 原始值 | 问题 | 修复过程 |
|--------|------|---------|
| `新华社记者` | 未处理新华社 | `^(新华社\|本报)` |
| `下转第二版` | 排版信息 | `if [上下]转: author=""` |
| `黄琬婷杨春竹记者孙宝福` | 中间带"记者" | 加`re.sub(r'\\s*(记者\|通讯员)\\s*', ' ', author)` |
| `《中国应急管理报》记者张楠` | 其他媒体记者 | `《[^》]+》记者[\\u4e00-\\u9fff]{2,4}` |
| `李冬梅高瑶`(\u65e0\u7a7a\u683c\u6c61\u67d3) | 胶连名 | 锚点法：李冬梅已知→锚点 |

## 尾部正文词清理

必须在 `re.sub(r'\\s+...\\s*$')` 中维护以下列表：

```
受、连日来、近日、日前、随着、面对、今年、截至、目前、正值、汛期
```

漏一个就可能把正文首词当作者（如"正值七下八上""汛期，一场暴雨"）。

## 本报评论员特殊处理

```python
# 仅标"本报评论员"无实际作者名时清空
if not author and re.search(r'^本报评论员', content_text[:30]) and \
   not re.search(r'本报(记者|通讯员)', content_text[:30]):
    author = ""
```

## 图片新闻 `image: true`

```python
is_pic = (final_title == "图片新闻") or (len(lines) < 3 and len(content) < 80)
```

标题"图片新闻"强制标记。body 中 `图/XX` 作为作者。

## 作者库更新

```python
# 差集法
new_found = set()
for file in ragtest_date_files:
    new_found.add(author_field)
to_add = new_found - KNOWN_AUTHORS
```

**注意**：`周宇张宁`(无空格)会被当单4字名→需检测 `len==4 and pos0/pos2均姓氏` 则跳过

**更新时必须汇报新增了谁**（用户明确要求）。
