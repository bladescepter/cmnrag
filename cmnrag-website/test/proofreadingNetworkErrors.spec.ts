import { describe, expect, it } from "vitest";
import { networkFailureMessage } from "../public/proofreading/network-errors.js";

describe("proofreading network failure stages", () => {
  it("warns a failed submission may already have been accepted", () => {
    const message = networkFailureMessage("POST", "/tasks");
    expect(message).toContain("POST /api/proofreading/tasks");
    expect(message).toContain("不要直接重复提交");
  });
  it("distinguishes availability, list and polling without exposing task ids", () => {
    expect(networkFailureMessage("GET", "/availability")).toContain("服务状态检查");
    expect(networkFailureMessage("GET", "/tasks")).toContain("任务列表读取");
    const message = networkFailureMessage("GET", "/tasks/secret-task-id");
    expect(message).toContain("任务进度读取");
    expect(message).not.toContain("secret-task-id");
  });
});
