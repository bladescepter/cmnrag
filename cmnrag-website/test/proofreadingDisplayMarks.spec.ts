import { describe, expect, it } from "vitest";
import { locateFinalOpinionMarks } from "../public/proofreading/display-marks.js";

describe("completed proofreading display marks (never a verdict filter)", () => {
  it("marks only unique literal quotes from the skill's error-line format", () => {
    const original = "标题\n城市内涝，天气晴好。\n精准气象服务。";
    const answer = "【口径】第2段：城市内涝 -> 改为：城市暴雨积涝（依据：口径）\n【文法】第2段：天气晴好 → 天气晴朗\n【口径】第3段：精准气象服务 -> 精细气象服务\n";
    expect(locateFinalOpinionMarks(original, answer).map(mark => original.slice(mark.start, mark.end)))
      .toEqual(["城市内涝", "天气晴好", "精准气象服务"]);
  });
  it("skips uncertain, absent, repeated and overlapping fragments instead of guessing", () => {
    const original = "错字错字。这里有错误机构名。";
    const answer = "【文法】第1段：错字 -> 改为：正确\n【准确】第1段：编造片段 -> 改为：正确\n" +
      "【准确】第1段：错误机构名 -> 改为：正确\n【准确】第1段：机构名 -> 改为：正确\n" +
      "待核实：这里有错误机构名\n搜索结果：错误机构名";
    expect(locateFinalOpinionMarks(original, answer)).toEqual([
      { start: original.indexOf("错误机构名"), end: original.indexOf("错误机构名") + "错误机构名".length },
    ]);
  });
  it("does not mark ordinary prose, unverified/positive items or a no-opinion answer", () => {
    const original = "错词。正确机构。";
    expect(locateFinalOpinionMarks(original, "无意见")).toEqual([]);
    expect(locateFinalOpinionMarks(original, "这里可能有错词\n正确机构的写法是……")).toEqual([]);
    expect(locateFinalOpinionMarks(original, "【文法】错词 -> 改为：正确词")).toEqual([]);
  });
  it("counts offsets in UTF-16, preserving original newlines and emoji", () => {
    const original = "🌤标题\n气象X金融";
    const marks = locateFinalOpinionMarks(original, "【文法】第2段：气象X金融 -> 改为：气象×金融");
    expect(marks).toEqual([{ start: original.indexOf("气象X金融"), end: original.length }]);
  });
});
