// Legacy structured-result compatibility only. Native Pi answers are never parsed through this module.
export function locate(issue, paragraphs) {
  if (!issue || typeof issue.quote !== 'string' || !issue.quote) throw new Error('invalid_anchor');
  const before = typeof issue.before === 'string' ? issue.before : '';
  const after = typeof issue.after === 'string' ? issue.after : '';
  const candidates = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    let from = 0;
    while (from <= paragraph.length) {
      const at = paragraph.indexOf(issue.quote, from);
      if (at < 0) break;
      candidates.push({ paragraph_id: `p${index}`, start: at, end: at + issue.quote.length,
        contextMatches: paragraph.slice(Math.max(0, at - before.length), at) === before && paragraph.slice(at + issue.quote.length, at + issue.quote.length + after.length) === after });
      from = at + 1;
    }
  }
  const local = candidates.filter(c => c.paragraph_id === issue.paragraph_id && c.contextMatches);
  const contextual = candidates.filter(c => c.contextMatches);
  const match = local.length === 1 ? local[0] : contextual.length === 1 ? contextual[0] : candidates.length === 1 ? candidates[0] : null;
  if (!match) throw new Error('ambiguous_anchor');
  return { paragraph_id: match.paragraph_id, start: match.start, end: match.end };
}
