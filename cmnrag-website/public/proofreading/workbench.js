/* The workbench renders only server state: no synthetic progress or sample findings. */
import { verifyAnchor } from "./anchors.js";
import { locateOpinionMarks, validateDisplayMarks, buildMarkSegments, OPINION_LINE, PROOFREADING_PHASES, currentProofreadingPhase } from "./display-marks.js";
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
// 提交只用默认模型；后端 availability 仍返回清单，页面不再展示选择器。

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
// 余额展示：后台中转的 DeepSeek 账户余额（全部已登录用户可见），显示在顶栏服务状态位置；
// 无数据时不覆盖顶栏已有的服务状态文字。
function renderBalance(balance) {
  const display = $("service-status");
  if (!balance || typeof balance.total !== "string") return;
  const currency = balance.currency === "CNY" ? "¥" : `${balance.currency} `;
  display.textContent = `余额 ${currency}${Number(balance.total).toFixed(2)}${balance.is_available === false ? "（不可用）" : ""}`;
}
async function refreshBalance() {
  try { renderBalance((await api("/availability")).balance); } catch { /* 余额不可用不影响使用 */ }
}
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
  const placeholder = node("option", "", entries.length ? "历史稿件（最近 10 篇）" : "暂无历史稿件");
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
    // Final opinions and their source locations are independent of quotation typography.
    const answer = safeText(task.result_text);
    const opinions = task.status !== "completed" ? [] : task.display_marks == null
      ? locateOpinionMarks(content, answer)
      : validateDisplayMarks(content, answer, task.display_marks) || locateOpinionMarks(content, answer, [], { requireLocations: true });
    const marks = opinions.flatMap(opinion => opinion.spans.map(span => ({ ...span, number: opinion.number })));
    const segments = buildMarkSegments(marks);
    let base = 0, segmentIndex = 0;
    const renderedNumbers = new Set();
    for (const text of paragraphs) {
      const paragraph = node("p", "source-paragraph");
      const paragraphEnd = base + text.length;
      let cursor = 0;
      while (segmentIndex < segments.length && segments[segmentIndex].end <= base) segmentIndex++;
      for (let i = segmentIndex; i < segments.length && segments[i].start < paragraphEnd; i++) {
        const segment = segments[i];
        const start = Math.max(segment.start, base) - base;
        const end = Math.min(segment.end, paragraphEnd) - base;
        paragraph.append(document.createTextNode(text.slice(cursor, start)));
        const mark = node("mark", "native-mark", text.slice(start, end));
        mark.setAttribute("data-n", segment.numbers.join(" "));
        mark.setAttribute("aria-label", `第 ${segment.numbers.join("、")} 条意见引文`);
        if (marks.some(range => range.scope === "line" && range.start <= base + start && range.end >= base + end)) {
          mark.setAttribute("title", "意见针对本行内容或需在本行增补；此处划出整行范围。");
        }
        if (segment.end <= paragraphEnd) for (const number of segment.endingNumbers) {
          renderedNumbers.add(number);
          const badge = node("span", "mark-number");
          badge.setAttribute("data-n", String(number));
          badge.setAttribute("aria-hidden", "true");
          mark.append(badge);
        }
        paragraph.append(mark);
        cursor = end;
      }
      paragraph.append(document.createTextNode(text.slice(cursor)));
      source.append(paragraph);
      base += text.length + 1; // Original paragraphs are split on the exact newline character.
    }
    const locatedCount = opinions.filter(opinion => renderedNumbers.has(opinion.number)).length;
    const unlocatedCount = opinions.length - locatedCount;
    const spanCount = new Set(marks.map(mark => `${mark.start}:${mark.end}`)).size;
    $("source-mark-count").textContent = opinions.length
      ? `意见 ${opinions.length} 条 · 划线 ${spanCount} 处${unlocatedCount ? ` · ${unlocatedCount} 条未定位（需补充定位信息）` : ""}`
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
  for (const [index, issue] of issues.entries()) {
    if (!issue || typeof issue !== "object" || typeof issue.id !== "string") continue;
    const number = index + 1;
    const anchor = verifyAnchor(issue, task.version_id, paragraphs);
    if (anchor) locations[anchor.index].push({ ...anchor, number });
    const card = node("article", "finding-card");
    card.id = `finding-${issue.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    card.tabIndex = 0;
    card.append(node("span", "opinion-number", String(number)));
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
    const matches = buildMarkSegments(locations[index]);
    let cursor = 0;
    for (const match of matches) {
      paragraph.append(document.createTextNode(text.slice(cursor, match.start)));
      const mark = node("mark", "source-mark", text.slice(match.start, match.end));
      mark.tabIndex = 0;
      mark.setAttribute("aria-label", `查看第 ${match.numbers.join("、")} 条校对意见`);
      const firstId = issues[match.numbers[0] - 1].id;
      mark.addEventListener("click", () => selectIssue(firstId));
      mark.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectIssue(firstId); } });
      paragraph.append(mark);
      for (const number of match.numbers) {
        const id = issues[number - 1].id;
        if (!highlights.has(id)) highlights.set(id, []);
        highlights.get(id).push(mark);
      }
      for (const number of match.endingNumbers) {
        const badge = node("span", "mark-number");
        badge.setAttribute("data-n", String(number));
        badge.setAttribute("role", "button");
        badge.setAttribute("aria-label", `查看第 ${number} 条校对意见`);
        badge.tabIndex = 0;
        const select = event => { event.stopPropagation(); selectIssue(issues[number - 1].id); };
        badge.addEventListener("click", select);
        badge.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(event); } });
        mark.append(badge);
      }
      cursor = match.end;
    }
    paragraph.append(document.createTextNode(text.slice(cursor)));
    source.append(paragraph);
  });
  function selectIssue(id) {
    for (const element of [...cards.values(), ...[...highlights.values()].flat()]) element.classList.remove("active");
    cards.get(id)?.classList.add("active");
    for (const mark of highlights.get(id) || []) mark.classList.add("active");
    (highlights.get(id)?.[0] || cards.get(id))?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const duration = task.status === "queued"
    ? formatDuration(task.created_at, new Date().toISOString())
    : task.status === "running"
      ? formatDuration(task.started_at, new Date().toISOString())
      : (task.status === "completed" || task.status === "partial")
        ? formatDuration(task.started_at, task.finished_at)
        : null;
  elapsed.hidden = duration === null;
  elapsed.textContent = duration === null ? "" : `${task.status === "queued" ? "已等待" : task.status === "running" ? "已校对" : "校对用时"} ${duration}`;
  if (task.status === "partial") progress.append(node("p", "task-note", task.location_status === "incomplete"
    ? "原文定位未完成；已保留校对意见，请联系管理员核查定位信息。"
    : task.result_format === "pi-final-text-v1" ? "技能执行未全部完成；以下保留 Pi 最终回答，不代表校对通过。" : "校对尚未全部完成，当前仅列已确认错误。"));
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
    const wasActive = currentTask && activeStates.has(currentTask.status);
    renderTask(task);
    // 任务结束后余额已变化：刷新一次余额显示。
    if (wasActive && !activeStates.has(task.status)) void refreshBalance();
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
  submitting = true;
  $("submit-button").disabled = true;
  message("");
  // Keep this key on network retry within this submission; don't generate a second paid job.
  const key = pendingKey || crypto.randomUUID();
  pendingKey = key;
  try {
    const task = await api("/tasks", { method: "POST", headers: { "content-type": "application/json", "x-idempotency-key": key }, body: JSON.stringify({ content }) });
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
// 已校对时长每秒本地刷新，不产生网络请求。
setInterval(() => {
  if (!currentTask || !activeStates.has(currentTask.status)) return;
  const elapsed = $("task-elapsed");
  const start = currentTask.status === "queued" ? currentTask.created_at : currentTask.started_at;
  const text = formatDuration(start, new Date().toISOString());
  if (text && !elapsed.hidden) elapsed.textContent = `${currentTask.status === "queued" ? "已等待" : "已校对"} ${text}`;
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
    renderBalance(state.balance);
    // 提交前不再弹确认；本机试运行模式仍改按钮文案以示区分。
    if (state.mode !== "online" && state.mode !== "unavailable") $("submit-button").textContent = "确认后试运行";
    await refreshList();
    const id = new URLSearchParams(location.search).get("task");
    if (validId(id)) openTask(id, false); else setView("form");
  } catch (error) { setReady(false); message(error.message); }
})();
