import { locateOpinionMarks, sourceLines, validateDisplayMarks } from '../../cmnrag-website/public/proofreading/display-marks.js';

export const LOCATION_INSTRUCTIONS = [
  '网页需要每条最终意见与原稿位置对应。意见正文仍严格采用校对技能的自然文本格式，不修改校对判断或输出无错项。',
  'manuscript 中每行前的 L1、L2 等是网页附加的物理行标识，空行也计数，标题、副标题、署名都在范围内；屏幕自动折行不计数。这些标识不是原稿，写草稿仍从 original.md 逐字复制。',
  '网页意见位置统一写“第N行”，使用 L 后的原稿物理行号，如【文法】第7行：“原句”；修改建议；原因。标题可写“第1行（主标题）”。每条意见必须对应实际原文；缺姓名、缺主语或增补内容时定位到需要增补的原句。',
  '在最终意见正文之后另起一行输出 <proofreading-locations>，其中仅写一个 JSON 数组，再输出 </proofreading-locations>。数组每项为 {"number":1,"lines":[2]}：number 按最终意见出现顺序从1编号，lines 为该意见实际针对的原稿物理行号（数字，不是正文第几段）。每条意见必须有一项；前后重复或矛盾可选择多个实际相关行，同一原稿行可以对应多条意见。无需计算字符偏移量。',
  '缺主语、缺姓名或需要增补内容时选择需要修改的原句所在行；标题、副标题选择实际标题行。无意见时数组为空。该定位块用于网页展示，程序会将它与意见正文分开保存。',
].join('\n');

// The explicit footer is transport metadata, not an opinion. Preserve the preceding text verbatim.
export function splitLocatedAnswer(raw) {
  const marker = /(?:^|\r?\n)<proofreading-locations>[ \t]*\r?\n?/.exec(raw);
  if (!marker) return { text: raw, locations: [] };
  const text = raw.slice(0, marker.index);
  const end = raw.indexOf('</proofreading-locations>', marker.index + marker[0].length);
  if (end < 0 || raw.slice(end + '</proofreading-locations>'.length).trim()) return { text, locations: [] };
  try {
    const locations = JSON.parse(raw.slice(marker.index + marker[0].length, end));
    return { text, locations: Array.isArray(locations) ? locations : [] };
  } catch { return { text, locations: [] }; }
}

export function numberedManuscript(content) {
  return sourceLines(content).map(line => `L${line.number}\t${line.text}`).join('\n');
}

export function resolveDisplayMarks(content, text, locations) {
  return locateOpinionMarks(content, text, locations, { requireLocations: true });
}

export function marksComplete(content, text, marks) {
  return validateDisplayMarks(content, text, marks) !== null;
}

export function locationRepairPrompt(content, text, marks) {
  const missing = marks.filter(opinion => !opinion.spans.length).map(opinion => opinion.number);
  return `已有校对意见不再修改或重新校对。本次仅补齐意见编号 ${missing.join('、')} 的原稿位置。只输出 <proofreading-locations> 包裹的 JSON 数组，每项为 {"number":1,"lines":[2]}；选择实际需要修改的原稿物理行号（L后的数字），不能填写正文段号或空行。无需调用任何工具或联网，不计算字符偏移。\n\n<existing-opinions>\n${text}\n</existing-opinions>\n<manuscript>\n${numberedManuscript(content)}\n</manuscript>`;
}
