/* Anchors use the immutable original text, UTF-16 offsets and an exact quote. */
export function verifyAnchor(issue, versionId, paragraphs) {
  const anchor = issue?.anchor;
  if (typeof versionId !== "string" || !versionId || !anchor || anchor.version_id !== versionId || !/^p\d+$/.test(anchor.paragraph_id)) return null;
  const index = Number(anchor.paragraph_id.slice(1));
  const text = paragraphs[index];
  if (typeof text !== "string" || !Number.isInteger(anchor.start) || !Number.isInteger(anchor.end)) return null;
  if (anchor.start < 0 || anchor.end <= anchor.start || anchor.end > text.length) return null;
  if (typeof issue.quote !== "string" || text.slice(anchor.start, anchor.end) !== issue.quote) return null;
  return { index, start: anchor.start, end: anchor.end };
}
