/* The workbench renders only server state: no synthetic progress or sample findings. */
import { verifyAnchor } from "./anchors.js";
import { locateOpinionMarks, OPINION_LINE, PROOFREADING_PHASES, currentProofreadingPhase } from "./display-marks.js";
import { requestJson } from "./request.js";
const $ = (id) => document.getElementById(id);
const api = requestJson;
const taskReads = new Set();
let listRead = null;
const labels = { queued: "排队中", running: "校对中", completed: "已完成", partial: "部分核查未完成", failed: "失败", cancelled: "已取消" };
const categories = { political: "政治", grammar: "文法", policy: "口径", accuracy: "准确" };
const activeStates = new Set(["queued", "running"]);
let currentId = null;
let currentTask = null;
let requestEpoch = 0;
let ready = false;
let submitting = false;
let pendingKey = null;
let requiresPaidConfirmation = false;
// 已配置模型时提交携带页面所选模型；旧后台未提供清单时由后端用默认模型。
function modelBody(content) {
  const row = $("model-row");
  if (!row || row.hidden) return { content };
  return { content, model: $("model-select").value };
}
const modelLabels = { "deepseek/deepseek-flash": "DeepSeek V4.1 Flash（快）", "xiaomi/mimo-v2.6-flash": "MiMo V2.6 Flash（小米）" };

function message(text) {
  $("page-message").textContent = text;
  $("page-message").hidden = !text;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function safeText(value) { return typeof value === "string" ? value : ""; }
function validId(id) { return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id); }
function setView(view) {
  $("submit-form").hidden = view !== "form";
  $("task-view").hidden = view !== "task";
  $("empty-view").hidden = view !== "empty";
}
function setReady(enabled) {
  ready = enabled;
  $("submit-button").disabled = !ready || submitting;
  $("service-status").textContent = ready ? "服务可用" : "服务不可用";
  $("service-status").classList.toggle("online", ready);
}
function renderList(items) {
  const list = $("task-list");
  list.replaceChildren();
  const entries = Array.isArray(items) ? items.filter(task => validId(task?.id)) : [];
  // Compact history dropdown (shown on narrow screens instead of the horizontal strip).
  const select = $("task-select");
  select.replaceChildren();
  const placeholder = node("option", "", entries.length ? "历史稿件（最近 5 篇）" : "暂无历史稿件");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = !entries.some(task => task.id === currentId);
  select.append(placeholder);
  if (!entries.length) {
    list.append(node("p", "empty-note", "暂无校对稿件。"));
    return;
  }
  for (const task of entries) {
    const option = node("option", "", `${safeText(task.title) || "未命名稿件"} · ${labels[task.status] || "状态未知"}`);
    option.value = task.id;
    option.selected = task.id === currentId;
    select.append(option);
  }
  for (const task of entries) {
    const button = node("button", "task-list-item");
    button.type = "button";
    button.classList.toggle("selected", task.id === currentId);
    button.append(node("strong", "", safeText(task.title) || "未命名稿件"));
    button.append(node("span", "", labels[task.status] || "状态未知"));
    button.addEventListener("click", () => openTask(task.id));
    list.append(button);
  }
}
async function refreshList() {
  if (listRead) return listRead;
  listRead = api("/tasks").then(data => renderList(data.items));
  try { await listRead; } finally { listRead = null; }
}
function renderReview(task) {
  const content = safeText(task.content);
  const paragraphs = content.split("\n");
  const source = $("source-text");
  const findings = $("findings");
  source.replaceChildren();
  findings.replaceChildren();
  const complete = task.status === "completed" || task.status === "partial";
  if (task.result_format === "pi-final-text-v1") {
    // Only AFTER completion: derive optional display marks from the final answer.
    // Ambiguous/nonliteral quotes remain unmarked; this never changes the Pi answer.
    // 意见行按顺序编号；划线携带同一编号；未定位的意见显式计数提示。
    const answer = safeText(task.result_text);
    const opinions = task.status === "completed" ? locateOpinionMarks(content, answer) : [];
    const marks = opinions.flatMap(opinion => opinion.spans.map(span => ({ ...span, number: opinion.number }))).sort((a, b) => a.start - b.start);
    let base = 0, markIndex = 0;
    for (const text of paragraphs) {
      const paragraph = node("p", "source-paragraph");
      let cursor = 0;
      while (markIndex < marks.length && marks[markIndex].start < base + text.length) {
        const { start, end, number } = marks[markIndex++];
        if (start < base || end > base + text.length) continue;
        paragraph.append(document.createTextNode(text.slice(cursor, start - base)));
        const mark = node("mark", "native-mark", text.slice(start - base, end - base));
        mark.setAttribute("data-n", String(number));
        mark.setAttribute("aria-label", `第 ${number} 条意见引文`);
        paragraph.append(mark);
        cursor = end - base;
      }
      paragraph.append(document.createTextNode(text.slice(cursor)));
      source.append(paragraph);
      base += text.length + 1; // Original paragraphs are split on the exact newline character.
    }
    const locatedCount = opinions.filter(opinion => opinion.spans.length).length;
    const unlocatedCount = opinions.length - locatedCount;
    const spanCount = marks.length;
    $("source-mark-count").textContent = opinions.length
      ? `意见 ${opinions.length} 条 · 划线 ${spanCount} 处${unlocatedCount ? ` · ${unlocatedCount} 条未定位（引文与原文不一致）` : ""}`
      : "只读 · 不自动改写";
    $("finding-count").textContent = "Pi 最终回答";
    // textContent + pre-wrap preserves every character without executing HTML or reconstructing opinions.
    // 意见行前置编号徽标（独立元素），正文文本节点逐字保留，不增删不改。
    const result = node("div", "native-result");
    const lines = answer.split("\n");
    let opinionIndex = 0;
    lines.forEach((line, index) => {
      if (OPINION_LINE.test(line)) {
        opinionIndex++;
        result.append(node("span", "opinion-number", String(opinionIndex)));
      }
      result.append(document.createTextNode(line));
      if (index < lines.length - 1) result.append(document.createTextNode("\n"));
    });
    findings.append(result);
    return;
  }
  $("source-mark-count").textContent = "只读 · 不自动改写";
  const issues = complete && Array.isArray(task.issues) ? task.issues : [];
  const locations = paragraphs.map(() => []);
  const cards = new Map();
  const highlights = new Map();
  for (const issue of issues) {
    if (!issue || typeof issue !== "object" || typeof issue.id !== "string") continue;
    const anchor = verifyAnchor(issue, task.version_id, paragraphs);
    if (anchor) locations[anchor.index].push({ ...anchor, id: issue.id });
    const card = node("article", "finding-card");
    card.id = `finding-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    card.tabIndex = 0;
    card.append(node("span", "finding-type", categories[issue.category] || "待核对"));
    card.append(node("blockquote", "", safeText(issue.quote)));
    card.append(node("p", "", safeText(issue.reason)));
    if (issue.suggestion) card.append(node("p", "suggestion", `建议：${safeText(issue.suggestion)}`));
    if (Array.isArray(issue.evidence)) for (const evidence of issue.evidence) {
      try {
        const url = new URL(evidence.url);
        if (url.protocol !== "https:") continue;
        const link = node("a", "evidence", safeText(evidence.title) || "查看依据 ↗");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
      } catch { /* invalid URL: do not render */ }
    }
    if (!anchor) card.append(node("p", "anchor-warning", "无法唯一定位原文，请人工核对。"));
    card.addEventListener("click", () => selectIssue(issue.id));
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectIssue(issue.id); } });
    cards.set(issue.id, card);
    findings.append(card);
  }
  paragraphs.forEach((text, index) => {
    const paragraph = node("p", "source-paragraph");
    const matches = locations[index].sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor) {
        cards.get(match.id)?.append(node("p", "anchor-warning", "定位与另一条意见重叠，请人工核对。"));
        continue;
      }
      paragraph.append(document.createTextNode(text.slice(cursor, match.start)));
      const mark = node("mark", "source-mark", text.slice(match.start, match.end));
      mark.tabIndex = 0;
      mark.setAttribute("aria-label", "查看对应校对意见");
      mark.addEventListener("click", () => selectIssue(match.id));
      mark.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectIssue(match.id); } });
      paragraph.append(mark);
      highlights.set(match.id, mark);
      cursor = match.end;
    }
    paragraph.append(document.createTextNode(text.slice(cursor)));
    source.append(paragraph);
  });
  function selectIssue(id) {
    for (const element of [...cards.values(), ...highlights.values()]) element.classList.remove("active");
    cards.get(id)?.classList.add("active");
    highlights.get(id)?.classList.add("active");
    (highlights.get(id) || cards.get(id))?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  $("finding-count").textContent = complete ? `${issues.length} 条意见` : "待校对完成";
  if (!issues.length) findings.append(node("p", "empty-note", task.status === "completed" ? "无意见" : task.status === "partial" ? "部分核查未完成，不能认定全文无错。" : "校对中，尚无结果。"));
  // 校对技能输出纪律：只呈现明确错误；搜索材料、正确项、待核实事项均为内部过程。
}
function formatDuration(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatSeconds(Math.floor((end - start) / 1000));
}
function formatSeconds(totalSeconds) {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
  return `${seconds} 秒`;
}
function renderTask(task) {
  currentTask = task;
  $("task-title").textContent = safeText(task.title) || "未命名稿件";
  $("task-meta").textContent = safeText(task.model) || "";
  $("task-status").textContent = labels[task.status] || "状态未知";
  const progress = $("task-progress");
  progress.replaceChildren();
  if (task.status === "running") {
    // 四阶段步进器：当前阶段带旋转指示动画；后台阶段名不逐条展示。
    const current = currentProofreadingPhase(task.stages);
    const stepper = node("div", "phase-stepper");
    PROOFREADING_PHASES.forEach((label, index) => {
      const phase = index + 1;
      const step = node("span", phase < current ? "phase done" : phase === current ? "phase active" : "phase");
      if (phase === current) {
        const spinner = node("span", "phase-spinner");
        spinner.setAttribute("aria-hidden", "true");
        step.append(spinner);
      } else if (index < current) {
        step.append(document.createTextNode("✓ "));
      }
      step.append(document.createTextNode(label));
      stepper.append(step);
    });
    progress.append(stepper);
  }
  // 计时独立于 aria-live 的阶段区，避免每秒播报一次。
  const elapsed = $("task-elapsed");
  const duration = activeStates.has(task.status)
    ? formatDuration(task.created_at, new Date().toISOString())
    : (task.status === "completed" || task.status === "partial")
      ? formatDuration(task.created_at, task.updated_at)
      : null;
  elapsed.hidden = duration === null;
  elapsed.textContent = duration === null ? "" : `${task.status === "queued" ? "已等待" : task.status === "running" ? "已持续" : "任务总用时"} ${duration}`;
  if (task.status === "partial") progress.append(node("p", "task-note", task.result_format === "pi-final-text-v1" ? "技能执行未全部完成；以下保留 Pi 最终回答，不代表校对通过。" : "校对尚未全部完成，当前仅列已确认错误。"));
  if (task.status === "failed" || task.status === "cancelled") progress.append(node("p", "task-note", "任务未完成，不能视为无意见。"));
  renderReview(task);
  setView("task");
}
async function refreshTask(id) {
  if (taskReads.has(id)) return;
  taskReads.add(id);
  const epoch = ++requestEpoch;
  try {
    const task = await api(`/tasks/${id}`);
    if (epoch !== requestEpoch || currentId !== id) return;
    if (!task || task.id !== id || ![...activeStates, "completed", "partial", "failed", "cancelled"].includes(task.status)) throw new Error("任务返回的数据无效，请联系管理员。");
    renderTask(task);
    message("");
  } catch (error) { if (epoch === requestEpoch) message(error.message); }
  finally { taskReads.delete(id); }
}
function openTask(id, push = true) {
  if (!validId(id)) return;
  requestEpoch++;
  currentId = id;
  currentTask = null;
  message("");
  setView("task");
  $("task-title").textContent = "正在读取稿件…";
  $("task-progress").replaceChildren();
  $("task-elapsed").hidden = true;
  $("source-text").replaceChildren();
  $("source-mark-count").textContent = "只读 · 不自动改写";
  $("findings").replaceChildren();
  if (push) history.pushState({}, "", `?task=${encodeURIComponent(id)}`);
  refreshTask(id);
  refreshList().catch(() => {});
}
function newDraft(push = true) {
  requestEpoch++;
  currentId = null;
  currentTask = null;
  message("");
  if (push) history.pushState({}, "", "/proofreading/");
  setView(ready ? "form" : "empty");
  refreshList().catch(() => {});
}
$("new-task").addEventListener("click", () => newDraft());
$("task-select").addEventListener("change", (event) => {
  const id = event.currentTarget.value;
  if (validId(id) && id !== currentId) openTask(id);
});
$("back-to-new").addEventListener("click", (event) => { event.preventDefault(); newDraft(); });
$("submit-form").addEventListener("input", () => { pendingKey = null; $("character-count").textContent = `${$("draft-content").value.length.toLocaleString()} 字符`; });
$("submit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ready || submitting) return;
  const form = event.currentTarget;
  const content = $("draft-content").value;
  if (!content.trim()) { message("稿件原文不能为空。"); return; }
  if (requiresPaidConfirmation && !window.confirm("这是本机试运行：Pi 将使用原版校对技能和工具完成任务，工具调用可能产生多轮模型用量，不再固定为五次。联网仅使用 TinyFish Search，不调用 Fetch、Agent 或 Browser。确认稿件及技能资料已获准外传，并接受本次 API 费用？")) return;
  submitting = true;
  $("submit-button").disabled = true;
  message("");
  // Keep this key on network retry within this submission; don't generate a second paid job.
  const key = pendingKey || crypto.randomUUID();
  pendingKey = key;
  try {
    const task = await api("/tasks", { method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": key }, body: JSON.stringify(modelBody(content)) });
    if (!validId(task.id)) throw new Error("任务已提交，但未返回有效编号；请刷新稿件列表后查看，不要重复提交。");
    form.reset();
    pendingKey = null;
    $("character-count").textContent = "0 字符";
    openTask(task.id);
  } catch (error) { message(error.message); }
  finally { submitting = false; $("submit-button").disabled = !ready; }
});
window.addEventListener("popstate", () => {
  const id = new URLSearchParams(location.search).get("task");
  if (validId(id)) openTask(id, false); else newDraft(false);
});
// 轮询间隔避开 5 秒：本地 wrangler dev 的 keep-alive 空闲超时恰为 5 秒，
// 5 秒轮询会与其发生竞态并触发 wrangler dev 致命退出（workers-sdk#15452）。
setInterval(() => {
  if (currentId && (!currentTask || activeStates.has(currentTask.status))) {
    refreshTask(currentId);
    refreshList().catch(() => {});
  }
}, 3000);
// 已持续时长每秒本地刷新，不产生网络请求。
setInterval(() => {
  if (!currentTask || !activeStates.has(currentTask.status) || !currentTask.created_at) return;
  const elapsed = $("task-elapsed");
  const text = formatDuration(currentTask.created_at, new Date().toISOString());
  if (text && !elapsed.hidden) elapsed.textContent = `${currentTask.status === "queued" ? "已等待" : "已持续"} ${text}`;
}, 1000);
(async function init() {
  try {
    let auth;
    try { auth = await fetch("/api/auth/me", { credentials: "same-origin" }); }
    catch { throw new Error("登录状态检查连接中断（GET /api/auth/me）；请确认本机测试服务仍在运行。"); }
    if (!auth.ok) {
      message('请先登录后使用校对工作台。');
      $("service-status").textContent = "需要登录";
      const link = node("a", "login-link", "前往登录 →");
      link.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      $("page-message").append(link);
      return;
    }
    const state = await api("/availability");
    if (state.ready !== true) throw new Error("校对服务尚未接入，暂不能提交稿件。");
    setReady(true);
    // 后端返回可用模型时显示选择器；只有一个模型时也展示当前选择，新增密钥后第二项自动出现。
    const models = Array.isArray(state.models?.available) ? state.models.available.filter(id => typeof id === "string") : [];
    if (models.length > 0) {
      const select = $("model-select");
      for (const id of models) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = modelLabels[id] || id;
        if (id === state.models.default) option.selected = true;
        select.append(option);
      }
      $("model-row").hidden = false;
    }
    requiresPaidConfirmation = state.mode === "offline-partial-test" || state.mode === "online-test";
    if (requiresPaidConfirmation) {
      const online = state.mode === "online-test";
      $("service-status").textContent = online ? "本机试运行 · Search 已接入" : "本机试运行 · 未联网";
      $("submit-button").textContent = "确认后试运行";
      $("submit-form").querySelector(".form-help").textContent = online
        ? "仅限已获准外传的去敏稿。由 Pi 使用原版技能完成校对，按实际工具往返产生模型费用。网页原样展示最终回答；事实检索仅使用 TinyFish Search。请求体上限 200 KB；尚需真实效果对照，不可直接用于正式发稿。"
        : "仅限已获准外传的去敏稿。由 Pi 使用原版技能完成校对，按实际工具往返产生模型费用。当前搜索不可用，任务若需要搜索则标记未完成。请求体上限 200 KB；不可直接用于正式发稿。";
    }
    await refreshList();
    const id = new URLSearchParams(location.search).get("task");
    if (validId(id)) openTask(id, false); else setView("form");
  } catch (error) { setReady(false); message(error.message); }
})();
