/* 公共会话脚本：填充顶部导航栏右侧用户区；公开页面未登录也可访问
   顶栏骨架（返回主页 + 模块导航）已静态写入各页面 HTML，本脚本只做：
   1. 读取登录态，已登录时填充用户名 / 管理员入口 / 退出登录
   2. 未登录时显示登录入口，不阻止公开页面加载
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
      bar.innerHTML = '<div class="auth-bar-inner"><div class="auth-left"><a class="auth-home" href="/">‹ 返回主页</a></div><nav class="auth-nav"><a class="auth-link" href="/db">报纸资料库</a><a class="auth-link" href="/schedule">排班系统</a></nav><div class="auth-right"></div></div>';
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

  function fillGuestBar() {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = el("div", { id: BAR_ID });
      bar.innerHTML = '<div class="auth-bar-inner"><div class="auth-left"><a class="auth-home" href="/"><span>主页</span></a></div><nav class="auth-nav"><a class="auth-link" href="/db">报纸资料库</a><a class="auth-link" href="/schedule">排班系统</a></nav><div class="auth-right"></div></div>';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    const path = location.pathname.replace(/\/$/, "");
    bar.querySelectorAll(".auth-nav .auth-link").forEach((link) => {
      if (link.getAttribute("href")?.replace(/\/$/, "") === path) link.classList.add("active");
    });
    const right = bar.querySelector(".auth-right");
    right.textContent = "";
    const next = encodeURIComponent(location.pathname + location.search);
    right.appendChild(el("a", { href: "/login.html?next=" + next, class: "auth-link" }, "登录"));
  }

  function style() {
    const s = el("style");
    s.textContent = `
      #auth-bar{position:sticky;top:0;z-index:200;color:var(--color-ink-2);background:var(--color-paper);border-bottom:1px solid var(--color-rule-strong);font-size:.875rem}
      #auth-bar .auth-bar-inner{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:1rem;width:min(calc(100% - 3rem),74rem);min-height:3rem;margin:0 auto;padding:.5rem 0}
      #auth-bar .auth-left{justify-self:start}
      #auth-bar .auth-nav{display:flex;align-items:center;justify-content:center;gap:.25rem}
      #auth-bar .auth-right{display:flex;align-items:center;justify-content:flex-end;gap:.75rem;min-width:0}
      #auth-bar .auth-home,#auth-bar .auth-link{display:inline-flex;align-items:center;min-height:2.25rem;padding:.5rem .75rem;color:var(--color-ink-2);background:transparent;border:0;border-radius:0;font-size:.875rem;text-decoration:none;white-space:nowrap}
      #auth-bar .auth-home{font-family:var(--font-mono);font-size:.75rem}
      #auth-bar .auth-home:hover,#auth-bar .auth-link:hover,#auth-bar .auth-link.active{color:var(--color-accent);background:var(--color-accent-soft)}
      #auth-bar .auth-link.active{font-weight:600}
      #auth-bar .auth-name{max-width:14ch;overflow:hidden;color:var(--color-muted);font-family:var(--font-mono);font-size:.75rem;text-overflow:ellipsis;white-space:nowrap}
      #auth-bar .auth-btn{padding-inline:.5rem}
      @media(max-width:40rem){
        #auth-bar .auth-bar-inner{display:flex;flex-wrap:wrap;justify-content:space-between;width:calc(100% - 2rem);gap:.25rem .5rem}
        #auth-bar .auth-nav{order:3;width:100%;justify-content:flex-start;overflow-x:auto}
        #auth-bar .auth-right{max-width:48%}
      }
    `;
    document.head.appendChild(s);
  }

  async function init() {
    style();
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (res.status === 200) {
        const data = await res.json();
        fillBar(data.user);
        return;
      }
    } catch (e) { /* 公开页面继续加载，显示登录入口 */ }
    fillGuestBar();
  }

  // 脚本位于 body 末尾，DOM 已就绪：立即发起鉴权请求，与页面其余解析并行，无需等待 DOMContentLoaded
  init();
})();
