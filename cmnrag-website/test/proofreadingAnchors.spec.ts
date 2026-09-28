import { describe, expect, it } from "vitest";
import { verifyAnchor } from "../public/proofreading/anchors.js";

describe("proofreading exact anchors", () => {
	const paragraphs = ["今天晴。今天晴。", "中国气象报\n气象"];
	const issue = { quote: "今天晴", anchor: { version_id: "v1", paragraph_id: "p0", start: 4, end: 7 } };
	it("distinguishes a repeated occurrence using verified offsets", () => {
		expect(verifyAnchor(issue, "v1", paragraphs)).toEqual({ index: 0, start: 4, end: 7 });
	});
	it("refuses stale versions and changed text", () => {
		expect(verifyAnchor(issue, "v2", paragraphs)).toBeNull();
		expect(verifyAnchor(issue, "v1", ["今天晴。今天雨。"])).toBeNull();
	});
	it("refuses guessed or out-of-range offsets", () => {
		expect(verifyAnchor({ ...issue, anchor: { ...issue.anchor, start: -1 } }, "v1", paragraphs)).toBeNull();
		expect(verifyAnchor({ ...issue, anchor: { ...issue.anchor, paragraph_id: "p5" } }, "v1", paragraphs)).toBeNull();
	});
	it("uses JavaScript UTF-16 positions for mixed text", () => {
		expect(verifyAnchor({ quote: "A", anchor: { version_id: "v1", paragraph_id: "p0", start: 2, end: 3 } }, "v1", ["🌤A"])).toEqual({ index: 0, start: 2, end: 3 });
	});
});
