// 只标识请求阶段，不转述底层异常、稿件内容、身份标头或任务编号。
export function networkFailureMessage(method, path) {
  if (method === "POST" && path === "/tasks") return "提交请求连接中断（POST /api/proofreading/tasks）；稿件可能已受理，请先检查任务列表，不要直接重复提交。";
  if (path === "/availability") return "服务状态检查连接中断（GET /api/proofreading/availability）；请确认本机测试服务仍在运行。";
  if (path === "/tasks") return "任务列表读取连接中断（GET /api/proofreading/tasks）；请确认本机测试服务仍在运行。";
  return "任务进度读取连接中断（GET /api/proofreading/tasks/:id）；已有任务不会因此重新提交，请确认本机测试服务仍在运行。";
}
