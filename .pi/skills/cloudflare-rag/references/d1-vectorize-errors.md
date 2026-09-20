# D1 + Vectorize Error Log

## 1. LIKE with Long Unicode (fixed with instr())

```
Error: D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
```

**Root cause:** D1/SQLite has a pattern complexity limit for LIKE. Long Chinese column names like "“人民至上、生命至上”主题实践活动 发挥气象防灾减灾第一道防线作用" (42+ chars containing full-width punctuation) trigger this.

**Fix:** Replace `column_name LIKE ?` with `instr(column_name, ?) > 0`. The `instr()` function does substring matching without pattern complexity limits and treats `%`/`_` as literal characters.

**Affected locations:** All user-supplied partial-match filters (column, theme, region, author).

## 2. VECTOR_QUERY_ERROR (returnMetadata limit)

```
VECTOR_QUERY_ERROR (code = 40025): with returnValues=true or returnMetadata=all, max top K is 50, but got 100
```

**Root cause:** When no structured filters are applied, `topK` was set to 100 with `returnMetadata: "all"`. Cloudflare Vectorize limits metadata-return queries to topK ≤ 50.

**Fix:** 
- Filtered queries (small eligible set): topK = 12 (with metadata filter)
- Unrestricted queries: topK = 50 with `returnMetadata: "all"`
- Never exceed topK=50 when requesting all metadata

## 3. D1 too many SQL variables

```
D1_ERROR: too many SQL variables at offset 439: SQLITE_ERROR
```

**Root cause:** When no filters are applied, all 528 article IDs were passed into a `WHERE c.article_id IN (?,?,...,?)` clause. SQLite/D1 limits the number of bind parameters.

**Fix:** Only include the article_id IN clause when the eligible set is meaningfully constrained (≤200 IDs). When unrestricted, the clause is redundant anyway since the chunks JOIN to articles already ensures correct results.

```ts
const articleFilter = eligibleIds.length < 200 
  ? ` AND c.article_id IN (${eligibleIds.map(() => "?").join(",")})` 
  : "";
```

## 4. form.reset() doesn't clear JS-set values

```
document.querySelector('#reset').addEventListener('click',()=>{form.reset();...})
```

**Root cause:** When a user selects a value from a custom dropdown (not a native `<select>`), the `<input>` value is set via JavaScript `input.value = "value"`. `form.reset()` only resets to `defaultValue` (from the HTML `value` attribute), but some browsers don't properly clear JS-set values.

**Fix:** Explicitly clear each input's value after calling `form.reset()`:

```js
columnInput.value='';
themeInput.value='';
// For all other inputs:
document.querySelectorAll('[name="date_from"],[name="date_to"],...').forEach(i=>i.value='');
```

## 5. Counting questions in RAG

```
User: "有多少篇关于妈祖的报道？"
Model: "根据档案证据，共有6篇。"
```

**Root cause:** The LLM can only see the top-K retrieved chunks (≤50), so it's answering counting questions from an incomplete view. The model may fabricate a count even when the prompt tells it not to.

**Fix:** Two-layer defense:
1. Server-side regex intercepts counting questions before they reach the model
2. Prompt-level instruction telling the model not to answer count questions

The regex approach is more reliable than prompt engineering alone for smaller models.
