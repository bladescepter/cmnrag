# Design — 中国气象报采访中心工具集

本文件定义网站多页面共用的视觉与交互系统。此次重设计只调整页面呈现、导航和信息层级；路由、接口、权限、数据和业务逻辑保持现状。

## Genre
editorial

## Macrostructure family
**Index-First**。首页以工具目录和更新目录为核心；资料库、统计和更新日志优先呈现检索、数据与条目；排班系统使用同一纸面系统的 Workbench 变体。

## Theme
**Broadsheet palette + Garden typography**。采用栏目运行看板确认的暖灰纸色、米白内容底、深墨绿文字、青绿色操作色和砖红提示色；保留 Garden 版的 Fraunces / Source Serif 4 / IBM Plex Mono 字体组合。保留纸张、细线和报纸式层级，不使用渐变、玻璃效果或卡片套卡片。

## Selected components
- Navigation: **N6 Newspaper Masthead**，三段式布局：左侧主页，中间报纸资料库（悬浮下拉）与排班系统，右侧登录状态
- Footer: **Ft1 Mast-headed**，首页与更新日志使用统一的简洁页脚
- Page family: 首页 Index-First；资料库/统计 Index-First；排班 Workbench；登录/审批 single-sheet/content

## Typography
- Display: Fraunces，罗马体，用于页面标题、工具标题和重要条目
- Body: Source Serif 4，中文回退至 Noto Serif SC / 宋体
- Mono: IBM Plex Mono，用于日期、状态和数据标签
- Display tracking: `-0.02em`
- Type scale anchor: `--text-display = clamp(2.75rem, 5vw + 1rem, 5rem)`

## Color tokens
- `--color-paper`: warm grey newspaper paper (`#efeee8`)
- `--color-paper-2`: warm off-white content paper (`#fbfaf5`)
- `--color-paper-3`: pressed-paper wash (`#e7e9e2`)
- `--color-ink`: deep blue-green ink (`#1d2d2e`)
- `--color-accent`: teal action color (`#1f6572`)
- `--color-accent-2`: brick-red secondary signal (`#b24a35`)
- `--color-rule`: cool grey paper rule (`#cfd4cc`)

所有页面颜色、阴影、间距和字体都从 `tokens.css` 读取；页面 CSS 不重复声明主题色。

## Motion and interaction
- 导航下拉菜单支持 hover 与 keyboard focus；“栏目运行看板”保留为不可用入口并明确标记“暂未上线”
- 交互只使用短时颜色/位移变化，不做装饰性入场动画
- 键盘焦点清晰可见；`prefers-reduced-motion` 下取消空间位移
- 320 / 375 / 414 / 768 px 不产生横向溢出

## Shared requirements
- `采访中心工具集` wordmark 和 Broadsheet 纸面系统贯穿所有页面，字体沿用 Garden 版
- 右上角登录状态继续显示当前用户名、管理员入口和退出登录
- 资料库既保留主入口，也通过下拉菜单提供“各省发稿看板”和“栏目运行看板”入口
- 首页采用简洁的三块入口网格：左上最新一期更新日志、左下日常工具、右侧大块报纸资料库；顶栏和页脚保持统一

## Exports
- Canonical tokens: `cmnrag-website/tokens.css`
- Served tokens: `cmnrag-website/public/tokens.css`
- Shared served stylesheet: `cmnrag-website/public/site.css`
