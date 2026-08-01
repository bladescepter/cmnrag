import { describe, expect, it } from "vitest";
import { buildRagPrompt } from "../src/ai/rag";

describe("RAG response discipline", () => {
	it("instructs the model to choose a structure based on question type", () => {
		const prompt = buildRagPrompt("局党组关于防灾减灾有哪些部署？", [{ id: "a:0", title: "部署", date: "2026-07-29", page: "一版", content: "压实责任。" }]);
		expect(prompt).toContain("先判断问题属于哪种任务类型");
		expect(prompt).toContain("事实定位");
		expect(prompt).toContain("清单 / 列举");
		expect(prompt).toContain("综合归纳");
		expect(prompt).toContain("最多 5 个一级要点");
	});
});
