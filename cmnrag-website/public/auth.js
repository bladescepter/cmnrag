/* 公共会话脚本：页面加载校验登录态，填充顶部导航栏右侧用户区；未登录跳登录页
   顶栏骨架（返回主页 + 模块导航）已静态写入各页面 HTML，本脚本只做：
   1. 校验登录态，未登录跳转登录页
   2. 填充用户名 / 管理员入口 / 退出登录
   3. 按当前路径标记导航高亮 */
(function () {
  const BAR_ID = "auth-bar";

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fillBar(user) {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      // 兜底：页面未嵌入静态顶栏时（理论上不会发生），补一个骨架
      bar = el("div", { id: BAR_ID });
      bar.innerHTML = '<div class="auth-bar-inner"><div class="auth-left"><a class="auth-home" href="/">‹ 返回主页</a></div><nav class="auth-nav"><a class="auth-link" href="/db">报纸资料库</a><a class="auth-link" href="/proofread">校对系统</a><a class="auth-link" href="/schedule">排班系统</a></nav><div class="auth-right"></div></div>';
      document.body.insertBefore(bar, document.body.firstChild);
    }

    // 当前页导航高亮
    const path = location.pathname.replace(/\/$/, "");
    bar.querySelectorAll(".auth-nav .auth-link").forEach((link) => {
      if (link.getAttribute("href") === path) link.classList.add("active");
    });

    // 右侧用户区
    const right = bar.querySelector(".auth-right");
    right.textContent = "";
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
  }

  function style() {
    const s = el("style");
    s.textContent = `
      #auth-bar{background:#0d2b52;color:#d5e5ff;font-size:13.5px;box-shadow:0 2px 8px #071b3930;position:sticky;top:0;z-index:40}
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
        fillBar(data.user);
        return;
      }
    } catch (e) { /* fallthrough to redirect */ }
    location.replace("/login.html?next=" + next);
  }

  // 脚本位于 body 末尾，DOM 已就绪：立即发起鉴权请求，与页面其余解析并行，无需等待 DOMContentLoaded
  init();
})();
