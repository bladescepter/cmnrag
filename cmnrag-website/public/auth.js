/* 公共会话脚本：页面加载校验登录态，渲染顶部导航栏；未登录跳登录页 */
(function () {
  const BAR_ID = "auth-bar";
  const NAV = [
    { href: "/db", label: "报纸资料库" },
    { href: "/proofread", label: "校对系统" },
    { href: "/schedule", label: "排班系统" }
  ];

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

    // 左：返回主页
    const left = el("div", { class: "auth-left" });
    const home = el("a", { href: "/", class: "auth-home" }, "‹ 返回主页");
    left.appendChild(home);

    // 中：模块导航（当前页高亮）
    const nav = el("nav", { class: "auth-nav" });
    const path = location.pathname.replace(/\/$/, "");
    NAV.forEach((item) => {
      const link = el("a", { href: item.href, class: "auth-link" }, item.label);
      if (path === item.href) link.classList.add("active");
      nav.appendChild(link);
    });

    // 右：用户名 / 管理员入口 / 退出登录
    const right = el("div", { class: "auth-right" });
    const name = el("span", { class: "auth-name" }, (user.display_name || user.username) + " 已登录");
    right.appendChild(name);
    if (user.role === "admin") {
      const link = el("a", { href: "/admin.html", class: "auth-link" }, "用户审批");
      right.appendChild(link);
    }
    const logout = el("button", { class: "auth-link auth-btn" }, "退出登录");
    logout.addEventListener("click", async () => {
      try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      location.href = "/login.html";
    });
    right.appendChild(logout);

    inner.appendChild(left);
    inner.appendChild(nav);
    inner.appendChild(right);
    bar.appendChild(inner);
  }

  function style() {
    const s = el("style");
    s.textContent = `
      #auth-bar{background:#123b72;color:#d5e5ff;font-size:13.5px;box-shadow:0 2px 8px #071b3930;position:sticky;top:0;z-index:40}
      #auth-bar .auth-bar-inner{max-width:1180px;margin:0 auto;padding:10px 24px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:14px}
      #auth-bar .auth-left{justify-self:start}
      #auth-bar .auth-nav{justify-self:center;display:flex;gap:6px;align-items:center}
      #auth-bar .auth-right{justify-self:end;display:flex;gap:14px;align-items:center}
      #auth-bar .auth-home{color:#a8c7ff;text-decoration:none;font-weight:650;white-space:nowrap;padding:6px 0}
      #auth-bar .auth-home:hover{color:#fff}
      #auth-bar .auth-link{color:#d5e5ff;text-decoration:none;cursor:pointer;background:none;border:none;font-size:13.5px;padding:6px 12px;border-radius:6px;white-space:nowrap}
      #auth-bar .auth-link:hover{color:#fff;background:#ffffff1a}
      #auth-bar .auth-link.active{color:#fff;background:#ffffff1f;font-weight:650}
      #auth-bar .auth-name{color:#cfe2ff;white-space:nowrap}
      #auth-bar .auth-btn{padding:6px 0}
      @media(max-width:860px){
        #auth-bar .auth-bar-inner{grid-template-columns:1fr auto;padding:8px 14px;gap:6px 12px}
        #auth-bar .auth-nav{grid-column:1/-1;grid-row:2;justify-self:center}
      }
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
