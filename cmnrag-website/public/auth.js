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
      bar.innerHTML = '<div class="auth-bar-inner"><div class="auth-left"><a class="auth-home" href="/">‹ 返回主页</a></div><nav class="auth-nav"><a class="auth-link" href="/db">报纸资料库</a><a class="auth-link" href="/schedule">排班系统</a><a class="auth-link" href="/proofreading/">校对工具</a></nav><div class="auth-right"></div></div>';
      document.body.insertBefore(bar, document.body.firstChild);
    }

    // 当前页导航高亮
    const path = location.pathname.replace(/\/$/, "");
    bar.querySelectorAll(".auth-nav .auth-link").forEach((link) => {
      if (link.getAttribute("href")?.replace(/\/$/, "") === path) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
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
      bar.innerHTML = '<div class="auth-bar-inner"><div class="auth-left"><a class="auth-home" href="/"><span>主页</span></a></div><nav class="auth-nav"><a class="auth-link" href="/db">报纸资料库</a><a class="auth-link" href="/schedule">排班系统</a><a class="auth-link" href="/proofreading/">校对工具</a></nav><div class="auth-right"></div></div>';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    const path = location.pathname.replace(/\/$/, "");
    bar.querySelectorAll(".auth-nav .auth-link").forEach((link) => {
      if (link.getAttribute("href")?.replace(/\/$/, "") === path) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
    });
    const right = bar.querySelector(".auth-right");
    right.textContent = "";
    const next = encodeURIComponent(location.pathname + location.search);
    right.appendChild(el("a", { href: "/login.html?next=" + next, class: "auth-link" }, "登录"));
  }

  async function init() {
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
