// Presentation-only: locate quotes from completed Pi opinions in the immutable original.
// Never infer missing offsets, change the answer, or mark a phrase that appears twice.
// 技能行格式（SKILL.md 输出规范）：【类别】第N段：“引文”；应改为“修改”；依据……
// 意见行按出现顺序编号；引文外层引号是分隔符；引文内的（括注）视为模型补充成分，
// 剥去后按各字面片段唯一出现且相邻的原则定位（用户确认：括注引文属自然写法，仍需对应划线）。
// 一条意见（如“末句X与前文Y重复”）可引用多个片段，共用同一编号。兼容旧箭头写法。
export const OPINION_LINE = /^【(?:政治|文法|口径|准确)】第[0-9一二三四五六七八九十百]+段[：:]/;
const LINE_HEAD = /^【(?:政治|文法|口径|准确)】第[0-9一二三四五六七八九十百]+段[：:]\s*(.*)$/;
const FRAGMENTS = /[“"]([^“”"]+)[”"]|`([^`]+)`/g;
const BRACKET_NOTE = /[（(][^（()）]*[)）]/;
const MAX_SEGMENT_GAP = 10; // 括注剥除后相邻片段间允许的最大原文距离，防止跨段误配

function errorPart(line) {
  const match = LINE_HEAD.exec(line);
  if (!match) return null;
  const rest = match[1];
  const cut = /[；;]|->|→/.exec(rest);
  return (cut ? rest.slice(0, cut.index) : rest).trim();
}

function locateVerbatim(original, text) {
  const start = original.indexOf(text);
  if (start < 0 || original.indexOf(text, start + 1) >= 0) return null;
  return { start, end: start + text.length };
}

// 引文含（括注）补充时的容错定位：剥除括注后，各字面片段须唯一出现、按序相邻。
function locateBracketTolerant(original, quote) {
  if (!BRACKET_NOTE.test(quote)) return null;
  const segments = quote.split(/[（(][^（()）]*[)）]/).map(part => part.trim()).filter(Boolean);
  if (!segments.length) return null; // 整条引文都是括注，无字面内容可定位
  const positions = [];
  let searchFrom = 0;
  for (const segment of segments) {
    const start = original.indexOf(segment, searchFrom);
    if (start < 0 || original.indexOf(segment, start + 1) >= 0) return null;
    positions.push({ start, end: start + segment.length });
    searchFrom = start + segment.length;
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].start - positions[i - 1].end > MAX_SEGMENT_GAP) return null;
  }
  return { start: positions[0].start, end: positions[positions.length - 1].end };
}

export function locateOpinionMarks(original, answer) {
  if (typeof original !== "string" || typeof answer !== "string") return [];
  const opinions = [];
  const taken = []; // 已占用区间，避免不同意见的划线互相重叠
  let number = 0;
  for (const line of answer.split(/\r?\n/)) {
    if (!OPINION_LINE.test(line)) continue;
    number++;
    const spans = [];
    const part = errorPart(line);
    if (part) {
      const fragments = [...part.matchAll(FRAGMENTS)].map(match => (match[1] ?? match[2] ?? "").trim()).filter(Boolean);
      const quotes = fragments.length ? fragments : [part];
      for (const quote of quotes) {
        const span = locateVerbatim(original, quote) || locateBracketTolerant(original, quote);
        if (!span) continue;
        if (taken.some(occupied => span.start < occupied.end && occupied.start < span.end)) continue;
        taken.push(span);
        spans.push(span);
      }
    }
    opinions.push({ number, spans });
  }
  return opinions;
}
