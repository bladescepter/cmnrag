# 校对后台

Node.js ≥22.19、Pi SDK 固定 0.87.1。**版本库不提交**真实稿件、API Key 或部署参数。本地开发使用回环监听；生产容器仅在 Docker 内网监听，经 VPS Caddy HTTPS 反代到 Worker。接口约定在 `../cmnrag-website/PROOFREADING-API.md`。

## 当前已实现（原生 Pi 技能执行器 `pi-skill-v1`）

- 接受 Worker 签发的 60 秒 HS256 身份 JWT（严格校验签名、受众、有效期）；每个请求按用户 ID 查自己的任务，跨用户返回 404。
- SQLite WAL 记录不可变稿件、稿件版本、技能包哈希、实际模型、阶段、最终回答原文（`result_text` / `result_format` / `usage` 新列，增量迁移，历史任务不改写）；每用户仅保留最近 10 篇任务，新提交时从早到晚自动删除更早历史（排队/运行中不删，删除事件记入诊断日志）；原子去重（用户 + 幂等键 + 内容）；单进程单任务队列，重启后未完成的运行中任务标失败，不假装可恢复。
- 每稿创建一次原生 `createAgentSession`，以 `/skill:proofreading …` 提交，由 Pi 自主循环 `read` / `write` / `bash` / `web_search` 工具完成技能：读取全部参考文件、写稿、运行原版扫描、四遍通读、必要搜索。**不再**有程序拼接的分遍 prompt、强制 JSON 校对回答、第五次 verdict、程序生成搜索词或意见锚点过滤。最终生成附带独立的原稿行号定位块，意见正文原样保存，定位范围另存；程序处理引号嵌套与样式差异，无法缩小片段时划出指定原稿行。正常路径不增加模型调用；缺少有效行号时最多在同一会话补一次定位（关闭所有工具），仍不完整则保留意见并标记 `partial`。（参考文件预注入首条 prompt 的方案已实测回退：模型仍按技能第零步重读文件，反而引发行为紊乱，同稿耗时 2.5 倍、token 3.3 倍；思考级别 `low` 同样实测回退：18 分钟未完成流程，慢于 medium 基线。）启动器把原稿预先写入技能目录 `original.md`（只读），模型写草稿从该文件逐字复制而非凭记忆重构，消除 `draft_must_match_original` 重试循环（实测该循环是多次“死区”的主因）；参考文件全部读完后发“Pi 通读校对中”阶段事件，页面不再滞留“读取资料中”。实际使用的思考级别随任务入库并写入诊断日志（失败任务也保留已累计用量）；工具调用被拒时记录 `tool_rejected`（工具名+错误码），用于定位模型重试循环。
- Pi 使用**显式**模型、独立凭据路径、内存会话及资源加载器，不发现宿主机个人技能、扩展或用户配置。最终回答取 assistant 文本块并逐字保存（含换行）；所需参考文件未完整读取、未成功扫描或已请求搜索失败时任务为 `partial`，保留回答。
- 工具最小权限：`read` 只读本任务规则快照与草稿；`write` 只能在本任务 `drafts/` 写入与原稿逐字一致的 `.md`；`bash` 只解析简单 argv，仅允许原版扫描脚本与本任务草稿 `rm`，不交给 shell，无 Key 环境；`web_search` 仅 TinyFish Search，一次合并查询，材料包一层不可信声明后交 Pi 自行判断。Search 不可用或请求失败标 incomplete，不冒充完成。
- 未配置 TinyFish 时仍可提交；Pi 请求搜索才产生 incomplete，不自动产生“部分核查未完成”结论。
- 网页不限模型调用次数；按实际工具往返记录用量，超五轮、超旧试验额度不丢结果；usage 缺失时保留回答并标记估算不可用。不设任务整体墙钟超时、每日篇数或 4000 字业务限制；保留 200 KB 请求保护、单供应商请求故障保护、扫描 30s/1MB 保护。
- **诊断日志**：`<stateDir>/diagnostics.jsonl`（网页模式在 `data/web-test/backend/`）以 JSONL 同步追加记录事件链（任务开始、模型调用计数、用量、联网检索的查询词原文、成败与错误码）及未捕获异常/未处理 rejection；不记录稿件正文、提示词、模型输出、搜索结果材料或密钥（查询词为稿件衍生的事实短句，系测试阶段行为核查需要，经用户确认后记入）。网页启动器另在 `data/web-test/supervisor.jsonl` 记录 backend/worker/migration 的启动、退出时间、退出码、信号和是否预期退出；Wrangler 标准错误流仅在内存中分类为预设错误类别，原文不写入日志。Worker 异常退出时保留后台校对任务，按 1/2/4/8/16/30 秒退避恢复网页（最长间隔 30 秒，稳定运行一分钟后重置退避）；启动失败会清理该次 Worker，不遗留占用端口的进程。只读 GET 的连接中断、响应体中断及 502/503/504 可短暂重试，任务轮询不会重叠，恢复后清除断线提示；POST 永不自动重提。此措施提高可恢复性，不代表 Wrangler 上游代理缺陷已修复。日志超 5 MB 轮转为 `.1`。被系统强制 SIGKILL 时启动器可能来不及写结束记录，需要结合系统日志判断。
- 历史结构化任务（`issues`/`unverified`/`verified`/`sources`）保持原样可读；`locate` 算法保留在 `src/legacy-anchors.js` 仅供旧测试与历史数据兼容，新执行器不使用。

## 本地开发（只用去敏稿件）

`npm ci && npm test`。启动前由操作者在安全的运行环境提供 `PROOFREADING_SIGNING_SECRET`（至少 32 字符，与 Worker secret `PROOFREADING_SIGNING_SECRET` 相同）、`PROOFREADING_RULES_DIR`（**已审定、只读**技能包目录）、`PROOFREADING_STATE_DIR`、`PROOFREADING_MODELS=deepseek/deepseek-flash`（`.env` 首行，目录顺序决定默认模型；实测后已下线较慢的小米 MiMo，密钥备份在本机 data/env-backups/），以及对应的 `PROOFREADING_API_KEY_<大写提供商>`（如 `PROOFREADING_API_KEY_DEEPSEEK`）；TinyFish 使用 `PROOFREADING_TINYFISH_API_KEY`。未配置密钥的模型不展示；页面选模型后按任务入队。未设置目录时仍兼容旧的单模型 `PROOFREADING_MODEL_PROVIDER` / `_ID` / `_API_KEY`，可选 `PROOFREADING_THINKING_LEVEL`（未设置时用该版本 Pi 默认，不强制关闭）。模型标识必须是已在 Pi 中核实的精确提供商/ID；不能把讨论中的展示名称直接填入。后台默认 `127.0.0.1:8788`；容器内部可用 `0.0.0.0`，但不发布宿主端口，只允许内网反代。

**默认不接受稿件**。仅限隔离环境下用去敏样本测试时，显式设置 `PROOFREADING_ENABLE_OFFLINE_PARTIAL=1`。本机网页试运行不设置每日篇数或 4000 字符的业务限制；每次提交仍须确认模型费用（原生工具循环可能产生多轮调用），HTTP 请求保留 200 KB 的传输保护上限。进程应使用专用低权限 OS 用户；状态目录仅该用户可读（0700），不可挂载用户个人 Pi 目录、仓库 `.env` 或其他项目。

### 本机单篇试运行（测试 Key，非网站上线）

仅使用经你确认可发给模型的**去敏短稿**，保存到仓库之外的 `.md` / `.txt` 文件（≤1200 字符）。`proofreading-service/.env` 仅在本机使用，权限应为 0600；网页多模型和本地单稿止损试验均从目录选用小米配置。`xiaomi` 配按量付费 `sk-` Key，Token Plan 的 `tp-` / `ttp-` Key 对应 `xiaomi-token-plan-cn`，不得混用。不需要设置 Worker 签名密钥或启动网站；本地脚本不开放端口，不读档案数据。

先在 `proofreading-service/` 运行**免费预检**：

```bash
npm run test:local -- /绝对路径/去敏短稿.md
```

显示模型、稿件字符数和本地止损上限；**不发送模型请求**。审查信息无误且同意本次可能产生的供应商费用后，手动在同一命令末尾追加 `--confirm-paid-call`。命令行试验保留小额止损（1200 字、2048 输出、累计 160000 token / $0.05 达阈值阻止下一次请求）；这些阈值可能不足以跑完原生工具循环，是**本地止损**而非网页完成条件，也不丢弃已经付费返回的结果。任一失败不宣称“无意见”。

### 本机浏览器试运行（你当前要用的入口）

在开发 PC 仓库中进入 `proofreading-service/`，运行：

```bash
npm run dev:web
```

此命令**只在本机**启动后台 `127.0.0.1:8788` 和 Wrangler `--local --host 127.0.0.1` 网页 `127.0.0.1:8787`（`--host` 避免 API 请求被改写为线上域名），使用独立的本机 SQLite/D1；只初始化**本地 D1 的登录表**，不执行远程数据库操作、不部署 Worker，也不会自行提交稿件或调用模型。首次创建被 Git 忽略且权限为 0600 的 `../cmnrag-website/.dev.vars`；若已有非本工具创建的文件则停止，不覆盖。后台读取 `proofreading-service/.env` 中你自己填写的测试模型 Key，Worker 不会接触该 Key。

打开 <http://127.0.0.1:8787/proofreading/>。首次使用先到同机 `/login.html` 注册本地账号；用文本编辑器打开 `cmnrag-website/.dev.vars`，将 `ADMIN_INIT_SECRET` 填入注册页的“管理员初始化密钥”栏（不要发到聊天，也不要提交文件）。注册完成后返回登录页登录；该账号只存在本地 D1，与线上账号不通用。

**点击提交并再次确认后才可能产生模型费用**：Pi 将用原版技能完成任务，工具往返可能多轮，不再固定五次调用；网页使用模型声明的输出上限（Pi 会按剩余上下文进一步收紧），不套用命令行试验阈值；仅记录累计用量和 SDK 预估费用，估算缺失时标注不可用。输出被截断会记录明确的 `model_output_truncated`，不自动重试。联网仅 TinyFish Search、一次合并查询，材料不展示、不执行其中指令；搜索失败如实标 `partial`。网页没有程序内金额上限，仍应在供应商控制台设置额度。按 Ctrl+C 停止；本机数据留在被忽略的 `proofreading-service/data/web-test/`，**不自动清除**。

## 生产部署（容器形态，需用户明确确认后执行）

部署目标为腾讯云香港 VPS（Caddy + `hermes-net` 反代模式，公网入口 `https://proofreading.xiyuan.wiki`）。要点：

1. **镜像**：`proofreading-service/Dockerfile`（Node 22 + Pi SDK 0.87.1）。从仓库根目录执行 `docker build -f proofreading-service/Dockerfile -t cmnrag-proofreading .`，以便后端与网页复用同一定位模块；配套 `Dockerfile.dockerignore` 只允许服务源码、依赖清单与网页定位模块进入构建上下文，不包含密钥、档案、任务数据与测试。端口不发布到宿主公网，仅 `hermes-net` 内可达。
2. **监听**：容器内 `PROOFREADING_HOST=0.0.0.0`（`bind-host.js` 白名单允许回环/通配/RFC1918 私网；公网地址与域名一律拒绝）；公网流量只经 Caddy TLS 反代进入。
3. **挂载**：`/app/data` 为持久卷（任务库与诊断日志）；`/app/rules` 为技能包 bind mount（宿主目录 rsync 更新）；密钥经挂载的 `.env`（600 权限）提供。
4. **权威文件更新流程**（已确认）：本地修改独立仓库 `/home/blade/Projects/proofreading/.pi/skills/proofreading/` → 在该仓库 git 提交推送（审核留痕）→ rsync 到 VPS `/opt/data/proofreading/rules/` → 空闲期重启容器（确认无 running 任务）→ 抽查验证。新规则指纹写入 `backend_start` 诊断日志，便于核对线上版本。
5. **Worker 侧**：配置 `PROOFREADING_BACKEND_URL=https://proofreading.xiyuan.wiki/`，按仓库根 AGENTS.md 流程 dry-run 后部署；全链路验收含 `/availability`、真实提交与余额显示。

## 与本地效果的差异声明

工程测试（含模拟模型/模拟搜索的端到端用例）只验证执行链路：技能激活、参考文件读取、扫描、搜索材料回流、最终文本逐字保存与权限边界。**不构成**“与本地 Pi 校对质量等价”的证据；正式使用前须按《校对服务落实方案.md》阶段 B 用同一模型、思考级别、技能和搜索能力做真实对照。Search-only 是用户明确允许的能力差异（无 Fetch/Agent/Browser）。

## 上线前仍需补齐

- 同配置真实模型回归（阶段 B）：无错误稿、典型错误、口径稿、需联网稿、长稿及故障路径，由用户验收。
- TinyFish Search 真实凭据连通性回归；本地假服务已覆盖协议与失败降级。
- 模型试用额度原子预留/结算和供应商侧财务熔断，BYOK 独立凭据上下文、并发/取消/重试与持久用量账本；本机试运行的事后 SDK 用量记录不足以控制生产费用。
- 工具隔离尚非完整沙箱；公开生产前评估容器/进程、文件与网络隔离。
- 版本化技能包的发布流程、备份加密/恢复及数据保存政策。
- Caddy TLS 反代与 Worker secret、后端签名密钥安全分发；上线前核验后台访问控制、代理和跨用户边界。

**未收到上线确认，不配置生产密钥、不开对外端口、不部署。**
