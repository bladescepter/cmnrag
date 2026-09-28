// Presentation-only: locate quotes from completed Pi opinions in the immutable original.
// Never infer missing offsets, change the answer, or mark a phrase that appears twice.
export function locateFinalOpinionMarks(original, answer) {
  if (typeof original !== "string" || typeof answer !== "string") return [];
  const marks = [];
  for (const line of answer.split(/\r?\n/)) {
    const match = /^【(?:政治|文法|口径|准确)】第[0-9一二三四五六七八九十百]+段[：:]\s*(.*?)\s*(?:->|→)\s*(?:改为[：:]\s*)?\S/.exec(line);
    if (!match) continue;
    const quote = match[1].trim();
    if (!quote) continue;
    const start = original.indexOf(quote);
    if (start < 0 || original.indexOf(quote, start + 1) >= 0) continue;
    const end = start + quote.length;
    if (marks.some(mark => start < mark.end && mark.start < end)) continue;
    marks.push({ start, end });
  }
  return marks.sort((a, b) => a.start - b.start);
}
