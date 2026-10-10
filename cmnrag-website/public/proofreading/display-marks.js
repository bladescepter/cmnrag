// Display locations refer to the immutable original, independently of opinion typography.
const LOCATION = "(?:第[0-9一二三四五六七八九十百]+[行段](?:[（(][^）)]+[）)])?|主标题|副标题|标题|引题|副题|署名|作者行|末段)";
// Count opinions independently of their location label, so malformed labels cannot vanish.
export const OPINION_LINE = /^[ \t]*【(?:政治|文法|口径|准确)】/;
const LINE_HEAD = new RegExp(`^[ \\t]*【(?:政治|文法|口径|准确)】(${LOCATION})[：:]\\s*(.*)$`);
const QUOTE_CHAR = /[“”‘’"'「」『』«»`]/u;
const BRACKET_NOTE = /[（(][^（()）]*[)）]/;
const MAX_SEGMENT_GAP = 10;

// One-based physical lines, including empty lines; offsets always use original UTF-16 units.
export function sourceLines(original) {
  let start = 0;
  return original.split("\n").map((text, index) => {
    const line = { number: index + 1, text, start, end: start + text.length };
    start += text.length + 1;
    return line;
  });
}

function errorPart(line) {
  const match = LINE_HEAD.exec(line);
  if (!OPINION_LINE.test(line)) return null;
  const rest = match ? match[2] : line.replace(OPINION_LINE, "").replace(/^[^：:]*[：:]\s*/, "");
  let depth = 0, straight = false, code = false;
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i];
    if (char === "`") code = !code;
    if (!code) {
      if (char === "“") depth++;
      if (char === "”") depth = Math.max(0, depth - 1);
      if (char === '"') straight = !straight;
    }
    if (!code && !straight && depth === 0 && (/[；;]/.test(char) || rest.startsWith("->", i) || char === "→")) {
      return rest.slice(0, i).trim();
    }
  }
  return rest.trim();
}

function unwrap(text) {
  const pairs = { "“": "”", '"': '"', "`": "`", "‘": "’", "「": "」", "『": "』" };
  return pairs[text[0]] === text.at(-1) ? text.slice(1, -1) : text;
}

// Keep nesting: an outer quotation may contain quotation marks already in the manuscript.
function fragments(part) {
  const pairs = { "“": "”", '"': '"', "`": "`", "「": "」", "『": "』" };
  const result = [];
  for (let i = 0; i < part.length; i++) {
    const close = pairs[part[i]];
    if (!close) continue;
    const open = part[i], start = i + 1;
    let depth = 1;
    for (i++; i < part.length; i++) {
      if (open !== close && part[i] === open) depth++;
      else if (part[i] === close) depth--;
      if (!depth) { result.push(part.slice(start, i)); break; }
    }
  }
  return result;
}

// Ignore quotation wrappers/styles only. Spaces and other punctuation can be the error itself.
function normalized(text, offset = 0) {
  let value = "";
  const starts = [], ends = [];
  for (let i = 0; i < text.length; i++) {
    if (QUOTE_CHAR.test(text[i])) continue;
    const char = /[—–－]/.test(text[i]) ? "—" : text[i];
    if (char === "—" && value.at(-1) === "—") { ends[ends.length - 1] = offset + i + 1; continue; }
    value += char;
    starts.push(offset + i); ends.push(offset + i + 1);
  }
  return { value, starts, ends };
}

function uniqueMatch(original, text, scopes, tolerant = false) {
  if (!text) return null;
  const needle = tolerant ? normalized(text).value : text;
  if (!needle) return null;
  const matches = [];
  for (const scope of scopes) {
    const raw = original.slice(scope.start, scope.end);
    const hay = tolerant ? normalized(raw, scope.start) : { value: raw };
    let from = 0, index;
    while ((index = hay.value.indexOf(needle, from)) >= 0) {
      let start = tolerant ? hay.starts[index] : scope.start + index;
      let end = tolerant ? hay.ends[index + needle.length - 1] : start + needle.length;
      // Newlines have no glyph to underline; keep endpoints on actual source paragraphs.
      while (start < end && original[start] === "\n") start++;
      while (end > start && original[end - 1] === "\n") end--;
      if (original.slice(start, end).trim()) matches.push({ start, end });
      if (matches.length > 1) return null;
      from = index + 1;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function locateQuote(original, quote, scopes) {
  // Preserve leading/trailing spaces in backtick quotes. They may be the actual error.
  const exact = uniqueMatch(original, quote, scopes) || uniqueMatch(original, quote, scopes, true);
  if (exact || !BRACKET_NOTE.test(quote)) return exact;
  const pieces = quote.split(/[（(][^（()）]*[)）]/).map(part => part.trim()).filter(Boolean);
  if (!pieces.length) return null;
  const positions = pieces.map(piece => uniqueMatch(original, piece, scopes) || uniqueMatch(original, piece, scopes, true));
  if (positions.some(position => !position)) return null;
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i].start - positions[i - 1].end;
    if (gap < 0 || gap > MAX_SEGMENT_GAP || original.slice(positions[i - 1].end, positions[i].start).includes("\n")) return null;
  }
  return { start: positions[0].start, end: positions.at(-1).end };
}

function validLocations(locations, lines) {
  const result = new Map(), duplicates = new Set();
  if (!Array.isArray(locations)) return result;
  for (const location of locations) {
    if (!location || !Number.isSafeInteger(location.number) || location.number < 1) continue;
    if (result.has(location.number) || duplicates.has(location.number)) {
      result.delete(location.number); duplicates.add(location.number); continue;
    }
    if (!Array.isArray(location.lines) || !location.lines.length || location.lines.length > lines.length) continue;
    const selected = [...new Set(location.lines)];
    if (selected.some(number => !Number.isSafeInteger(number) || number < 1 || number > lines.length || !lines[number - 1].text.trim())) continue;
    result.set(location.number, selected.map(number => lines[number - 1]));
  }
  return result;
}

// A physical line label is also explicit metadata, including blank lines in its numbering.
function physicalScope(label, lines) {
  const match = /^第([0-9一二三四五六七八九十百]+)行/.exec(label || "");
  if (!match) return null;
  const digits = "零一二三四五六七八九";
  let number = 0, digit = 0;
  if (/^[0-9]+$/.test(match[1])) number = Number(match[1]);
  else for (const char of match[1]) {
    if (char === "十" || char === "百") { number += (digit || 1) * (char === "十" ? 10 : 100); digit = 0; }
    else digit = digits.indexOf(char);
  }
  if (!/^[0-9]+$/.test(match[1])) number += digit;
  const line = Number.isSafeInteger(number) && number > 0 ? lines[number - 1] : null;
  return line?.text.trim() ? [line] : null;
}

// Historical answers have no explicit physical line IDs. Use paragraph labels only as a fallback.
function legacyScope(label, lines) {
  const nonempty = lines.filter(line => line.text.trim());
  const heading = nonempty[0];
  if (/^(?:主标题|标题)$/.test(label)) return heading ? [heading] : [];
  if (/^(?:副标题|副题|引题)$/.test(label)) {
    const subtitle = nonempty.slice(1).find(line => /^\s*[—–－]/.test(line.text));
    return subtitle ? [subtitle] : [];
  }
  if (/^(?:署名|作者行)$/.test(label)) {
    const author = nonempty.find(line => /^(?:\s*本报|\s*记者|\s*通讯员)/.test(line.text));
    return author ? [author] : [];
  }
  if (label === "末段") return nonempty.length ? [nonempty.at(-1)] : [];
  // Numeric labels in old skill answers commonly count nonempty paragraphs, including headings.
  const match = /^第([0-9]+)段/.exec(label);
  const paragraph = match ? nonempty[Number(match[1]) - 1] : null;
  return paragraph ? [paragraph] : [];
}

export function locateOpinionMarks(original, answer, locations = [], { requireLocations = false } = {}) {
  if (typeof original !== "string" || typeof answer !== "string") return [];
  const lines = sourceLines(original), explicit = validLocations(locations, lines);
  const whole = [{ start: 0, end: original.length }];
  const opinions = [];
  for (const line of answer.split(/\r?\n/)) {
    if (!OPINION_LINE.test(line)) continue;
    const head = LINE_HEAD.exec(line);
    const number = opinions.length + 1, spans = [], scope = explicit.get(number) || physicalScope(head?.[1], lines);
    const part = errorPart(line);
    if (!requireLocations || scope) {
      const searchScopes = scope || whole;
      const full = part && locateQuote(original, unwrap(part), searchScopes);
      const quotes = full ? [] : fragments(part || "");
      if (full) spans.push(full);
      else for (const quote of quotes.length ? quotes : [part]) {
        const span = quote && locateQuote(original, quote, searchScopes);
        if (span && !spans.some(existing => existing.start === span.start && existing.end === span.end)) spans.push(span);
      }
      // Missing text (e.g. a required name) belongs to a source line, not to an invented substring.
      if (!spans.length) {
        const fallback = scope || legacyScope(head?.[1], lines);
        // In historical repeated quotations, the paragraph label can disambiguate before a whole-line fallback.
        for (const target of fallback) {
          const match = part && locateQuote(original, unwrap(part), [target]);
          spans.push(match || { start: target.start, end: target.end, scope: "line" });
        }
      }
    }
    opinions.push({ number, spans });
  }
  return opinions;
}

// Stored ranges are checked again in the browser before rendering; missing ranges never disappear silently.
export function validateDisplayMarks(original, answer, marks) {
  const expected = locateOpinionMarks(original, answer, [], { requireLocations: true });
  if (!Array.isArray(marks) || marks.length !== expected.length) return null;
  // Only the skill's explicit no-opinion verdict can legitimately have no locations.
  if (!expected.length && answer.trim() !== "无意见") return null;
  const numbers = new Set();
  for (const opinion of marks) {
    if (!opinion || !Number.isSafeInteger(opinion.number) || opinion.number < 1 || opinion.number > expected.length || numbers.has(opinion.number) || !Array.isArray(opinion.spans) || !opinion.spans.length) return null;
    numbers.add(opinion.number);
    for (const span of opinion.spans) {
      if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > original.length || original[span.end - 1] === "\n" || !original.slice(span.start, span.end).trim()) return null;
      if (span.scope !== undefined && span.scope !== "line") return null;
    }
  }
  return marks;
}

// Split overlapping ranges; the original is rendered once and every number retains its endpoint badge.
export function buildMarkSegments(marks) {
  const boundaries = [...new Set(marks.flatMap(mark => [mark.start, mark.end]))].sort((a, b) => a - b);
  const segments = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1], end = boundaries[i];
    const covering = marks.filter(mark => mark.start <= start && mark.end >= end);
    if (!covering.length) continue;
    const numbers = [...new Set(covering.map(mark => mark.number))].sort((a, b) => a - b);
    const endingNumbers = [...new Set(covering.filter(mark => mark.end === end).map(mark => mark.number))].sort((a, b) => a - b);
    segments.push({ start, end, numbers, endingNumbers });
  }
  return segments;
}

export const PROOFREADING_PHASES = ["读取资料中", "通读稿件中", "事实核查中", "生成结果中"];
const STAGE_PHASE = [
  [/载入原版校对技能/, 1],
  [/读取技能参考文件/, 1],
  [/读取原稿|通读校对中|写入本任务草稿|执行关键词扫描/, 2],
  [/调用 TinyFish Search/, 3],
  [/会话已结束/, 4],
];
export function currentProofreadingPhase(stages) {
  let phase = 1;
  if (Array.isArray(stages)) for (const stage of stages) {
    if (stage?.status !== "done") continue;
    for (const [pattern, index] of STAGE_PHASE) if (pattern.test(typeof stage?.name === "string" ? stage.name : "")) { phase = Math.max(phase, index); break; }
  }
  return phase;
}
