// Presentation-only: locate quotes from completed Pi opinions in the immutable original.
// Never infer missing offsets, change the answer, or mark a phrase that appears twice.
// 技能规定的行格式（SKILL.md 输出规范）：
//   【口径】第X段：“引文”；应改为“修改”；依据……
// 引文外层的引号/反引号只是分隔符，定位时剥去；兼容旧箭头写法“引文 -> 改为：修改”。
const ERROR_LINE = /^【(?:政治|文法|口径|准确)】第[0-9一二三四五六七八九十百]+段[：:]\s*(.+?)\s*(?:[；;]\s*应改为|(?:->|→)\s*(?:改为[：:]\s*)?)/;
const QUOTE_PAIRS = [["“", "”"], ["\"", "\""], ["‘", "’"], ["'", "'"], ["`", "`"], ["「", "」"], ["『", "』"]];

function unwrapQuote(text) {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) return text.slice(1, -1).trim();
  }
  return null;
}

export function locateFinalOpinionMarks(original, answer) {
  if (typeof original !== "string" || typeof answer !== "string") return [];
  const marks = [];
  for (const line of answer.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    if (!raw) continue;
    const candidates = [];
    const unwrapped = unwrapQuote(raw);
    if (unwrapped) candidates.push(unwrapped);
    candidates.push(raw);
    let located = null;
    for (const quote of candidates) {
      if (!quote) continue;
      const start = original.indexOf(quote);
      if (start < 0 || original.indexOf(quote, start + 1) >= 0) continue;
      located = { start, end: start + quote.length };
      break;
    }
    if (!located) continue;
    if (marks.some(mark => located.start < mark.end && mark.start < located.end)) continue;
    marks.push(located);
  }
  return marks.sort((a, b) => a.start - b.start);
}
