/* 公共会话脚本：页面加载校验登录态，渲染顶部用户栏；未登录跳登录页 */
(function () {
  const BAR_ID = "auth-bar";

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderBar(user) {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = el("div", { id: BAR_ID });
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.textContent = "";
    const inner = el("div", { class: "auth-bar-inner" });
    const name = el("span", { class: "auth-name" }, (user.display_name || user.username) + " 已登录");
    inner.appendChild(name);
    if (user.role === "admin") {
      const link = el("a", { href: "/admin.html", class: "auth-link" }, "用户审批");
      inner.appendChild(link);
    }
    const logout = el("button", { class: "auth-link auth-btn" }, "退出登录");
    logout.addEventListener("click", async () => {
      try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      location.href = "/login.html";
    });
    inner.appendChild(logout);
    bar.appendChild(inner);
  }

  function style() {
    const s = el("style");
    s.textContent = `
      #auth-bar{background:#0d2b52;color:#d5e5ff;font-size:13px}
      #auth-bar .auth-bar-inner{max-width:1180px;margin:0 auto;padding:8px 24px;display:flex;gap:14px;align-items:center;justify-content:flex-end}
      #auth-bar .auth-link{color:#9fc0ff;text-decoration:none;cursor:pointer;background:none;border:none;font-size:13px}
      #auth-bar .auth-link:hover{color:#fff}
      #auth-bar .auth-btn{padding:0}
    `;
    document.head.appendChild(s);
  }

  async function init() {
    style();
    const next = encodeURIComponent(location.pathname + location.search);
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.status === 200) {
        const data = await res.json();
        renderBar(data.user);
        return;
      }
    } catch (e) { /* fallthrough to redirect */ }
    location.replace("/login.html?next=" + next);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
