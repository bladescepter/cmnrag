import { describe, expect, it } from "vitest";
import { locateOpinionMarks, OPINION_LINE, PROOFREADING_PHASES, currentProofreadingPhase } from "../public/proofreading/display-marks.js";

describe("completed proofreading display marks (never a verdict filter)", () => {
  it("numbers opinion lines and marks unique quotes in the skill's instructed format", () => {
    const original = "标题\n城市内涝，天气晴好。\n精准气象服务。";
    const answer = "【口径】第2段：“城市内涝”；应改为“城市暴雨积涝”；依据：口径。\n" +
      "【文法】第2段：`天气晴好`；应改为`天气晴朗`；口径术语。\n" +
      "【口径】第3段：精准气象服务；应改为精细气象服务；依据：案例·服务精细。\n";
    const opinions = locateOpinionMarks(original, answer);
    expect(opinions.map(opinion => opinion.number)).toEqual([1, 2, 3]);
    expect(opinions.map(opinion => opinion.spans.map(span => original.slice(span.start, span.end))))
      .toEqual([["城市内涝"], ["天气晴好"], ["精准气象服务"]]);
  });
  it("locates quotes despite parenthetical insertions, marking only the literal original", () => {
    const original = "各部门各市县做好防范工作。联合省水务厅发布黄色山洪灾害气象风险预警，覆盖14个市县。";
    const answer = "【口径】第5段：“（省气象局）联合省水务厅发布黄色山洪灾害气象风险预警”；应改为“省水务厅与省气象局联合发布黄色山洪灾害气象风险预警”。\n";
    const [opinion] = locateOpinionMarks(original, answer);
    expect(opinion.number).toBe(1);
    expect(original.slice(opinion.spans[0].start, opinion.spans[0].end))
      .toBe("联合省水务厅发布黄色山洪灾害气象风险预警");
  });
  it("one repetition opinion quotes two passages under a single number", () => {
    const original = "加强应急调度和值班值守，做好应对预案。\n另起一段。\n加强值班值守，并强化水库调度。";
    const answer = "【文法】第2段：末句“加强值班值守，并强化水库调度”与本段前文“加强应急调度和值班值守”重复；应删去其一。\n";
    const [opinion] = locateOpinionMarks(original, answer);
    expect(opinion.number).toBe(1);
    expect(opinion.spans.map(span => original.slice(span.start, span.end)))
      .toEqual(["加强值班值守，并强化水库调度", "加强应急调度和值班值守"]);
  });
  it("never marks correction-side or explanation quotes, only the error part before the separator", () => {
    const original = "省气象局于启动台风四级预警（海上）。自9月12日起，各地防范。";
    const answer = "【文法】第1段：“省气象局于启动台风四级预警（海上）”；应改为“省气象局启动台风四级预警（海上）”；句首已有“自9月12日起”作时间状语。\n";
    const [opinion] = locateOpinionMarks(original, answer);
    expect(opinion.spans.map(span => original.slice(span.start, span.end)))
      .toEqual(["省气象局于启动台风四级预警（海上）"]);
  });
  it("keeps numbering opinions whose quotes are absent, repeated or overlapping, without guessing", () => {
    const original = "错字错字。这里有错误机构名。";
    const answer = "【文法】第1段：“错字”；应改为“正确”。\n【准确】第1段：“编造片段”；应改为“正确”。\n" +
      "【准确】第1段：“错误机构名”；应改为“正确机构名”。\n【准确】第1段：“机构名”；应改为“正确机构名”。\n" +
      "待核实：这里有错误机构名\n搜索结果：错误机构名";
    const opinions = locateOpinionMarks(original, answer);
    expect(opinions.map(opinion => opinion.number)).toEqual([1, 2, 3, 4]);
    expect(opinions.map(opinion => opinion.spans.length)).toEqual([0, 0, 1, 0]);
    expect(original.slice(opinions[2].spans[0].start, opinions[2].spans[0].end)).toBe("错误机构名");
  });
  it("does not number or mark ordinary prose or a no-opinion answer", () => {
    const original = "错词。正确机构。";
    expect(locateOpinionMarks(original, "无意见")).toEqual([]);
    expect(locateOpinionMarks(original, "这里可能有错词\n正确机构的写法是……")).toEqual([]);
    expect(OPINION_LINE.test("【文法】错词；应改为正确词")).toBe(false);
  });
  it("still accepts the legacy arrow line format", () => {
    const original = "城市内涝，天气晴好。";
    const answer = "【口径】第1段：城市内涝 -> 改为：城市暴雨积涝\n【文法】第1段：天气晴好 → 天气晴朗\n";
    expect(locateOpinionMarks(original, answer).map(opinion => opinion.spans.map(span => original.slice(span.start, span.end))))
      .toEqual([["城市内涝"], ["天气晴好"]]);
  });
  it("counts offsets in UTF-16, preserving original newlines and emoji", () => {
    const original = "🌤标题\n气象X金融";
    const [opinion] = locateOpinionMarks(original, "【文法】第2段：“气象X金融”；应改为“气象×金融”。");
    expect(opinion.spans).toEqual([{ start: original.indexOf("气象X金融"), end: original.length }]);
  });
});

describe("four-phase progress display", () => {
  it("maps backend stage names onto the four display phases", () => {
    expect(PROOFREADING_PHASES).toEqual(["读取资料中", "通读稿件中", "事实核查中", "生成结果中"]);
    const done = names => names.map(name => ({ name, status: "done" }));
    expect(currentProofreadingPhase(done(["Pi 已载入原版校对技能"]))).toBe(1);
    expect(currentProofreadingPhase(done(["Pi 已载入原版校对技能", "Pi 读取技能参考文件"]))).toBe(1);
    // 参考文件读完即进入通读：不再等到写草稿才离开“读取资料中”。
    expect(currentProofreadingPhase(done(["Pi 读取技能参考文件", "Pi 通读校对中"]))).toBe(2);
    expect(currentProofreadingPhase(done(["Pi 读取原稿"]))).toBe(2);
    expect(currentProofreadingPhase(done(["Pi 读取技能参考文件", "Pi 写入本任务草稿", "Pi 执行关键词扫描"]))).toBe(2);
    expect(currentProofreadingPhase(done(["Pi 执行关键词扫描", "Pi 调用 TinyFish Search"]))).toBe(3);
    expect(currentProofreadingPhase(done(["Pi 调用 TinyFish Search", "Pi 会话已结束"]))).toBe(4);
  });
  it("starts at phase one and ignores unknown or unfinished stages", () => {
    expect(currentProofreadingPhase([])).toBe(1);
    expect(currentProofreadingPhase(undefined)).toBe(1);
    expect(currentProofreadingPhase([{ name: "Pi 调用 TinyFish Search", status: "running" }])).toBe(1);
    expect(currentProofreadingPhase([{ name: "未知阶段名", status: "done" }])).toBe(1);
  });
});
