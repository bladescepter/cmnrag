import { describe, expect, it } from "vitest";
import { locateFinalOpinionMarks } from "../public/proofreading/display-marks.js";

describe("completed proofreading display marks (never a verdict filter)", () => {
  it("marks unique quotes in the skill's instructed line format, unwrapping delimiter quotes", () => {
    const original = "标题\n城市内涝，天气晴好。\n精准气象服务。";
    const answer = "【口径】第2段：“城市内涝”；应改为“城市暴雨积涝”；依据：口径。\n" +
      "【文法】第2段：`天气晴好`；应改为`天气晴朗`；口径术语。\n" +
      "【口径】第3段：精准气象服务；应改为精细气象服务；依据：案例·服务精细。\n";
    expect(locateFinalOpinionMarks(original, answer).map(mark => original.slice(mark.start, mark.end)))
      .toEqual(["城市内涝", "天气晴好", "精准气象服务"]);
  });
  it("skips uncertain, absent, repeated and overlapping fragments instead of guessing", () => {
    const original = "错字错字。这里有错误机构名。";
    const answer = "【文法】第1段：“错字”；应改为“正确”。\n【准确】第1段：“编造片段”；应改为“正确”。\n" +
      "【准确】第1段：“错误机构名”；应改为“正确机构名”。\n【准确】第1段：“机构名”；应改为“正确机构名”。\n" +
      "【文法】第2段：末句“错字错字”与本段前文“错字”重复；应改为删去其一。\n" +
      "待核实：这里有错误机构名\n搜索结果：错误机构名";
    expect(locateFinalOpinionMarks(original, answer)).toEqual([
      { start: original.indexOf("错误机构名"), end: original.indexOf("错误机构名") + "错误机构名".length },
    ]);
  });
  it("does not mark ordinary prose, unverified/positive items or a no-opinion answer", () => {
    const original = "错词。正确机构。";
    expect(locateFinalOpinionMarks(original, "无意见")).toEqual([]);
    expect(locateFinalOpinionMarks(original, "这里可能有错词\n正确机构的写法是……")).toEqual([]);
    expect(locateFinalOpinionMarks(original, "【文法】错词；应改为正确词")).toEqual([]);
  });
  it("still accepts the legacy arrow line format", () => {
    const original = "城市内涝，天气晴好。";
    const answer = "【口径】第1段：城市内涝 -> 改为：城市暴雨积涝\n【文法】第1段：天气晴好 → 天气晴朗\n";
    expect(locateFinalOpinionMarks(original, answer).map(mark => original.slice(mark.start, mark.end)))
      .toEqual(["城市内涝", "天气晴好"]);
  });
  it("counts offsets in UTF-16, preserving original newlines and emoji", () => {
    const original = "🌤标题\n气象X金融";
    const marks = locateFinalOpinionMarks(original, "【文法】第2段：“气象X金融”；应改为“气象×金融”。");
    expect(marks).toEqual([{ start: original.indexOf("气象X金融"), end: original.length }]);
  });
});
