# 校对工作台：Worker ↔ 本机后台接口契约（未部署）

此文档描述网页、Worker 与仓库内 `../proofreading-service/` 初版后台的接口要求，不是后台已部署或可用于生产的声明。`/proofreading/` 延用现有登录账号；生产 Worker **未配置后台地址和签名密钥时返回 503**，页面禁止提交，不造虚假结果。未获得明确上线确认不得配置生产密钥、部署或发送真实未刊稿。

当前执行器为**原生 Pi 技能**（`execution: "pi-skill-v1"`）：一次提交创建独立 Pi 会话，Pi 自主循环 `read`/`write`/`bash`/`web_search` 完成校对技能，最终回答为自然文本并逐字保存。接口同时保留历史结构化任务字段以便旧数据可读。

## Worker 配置与信任边界

- `PROOFREADING_BACKEND_URL`：生产后台 HTTPS 根地址（末尾 `/`，无用户名、密码、查询、路径）；生产使用受保护连接，不公开可绕过 Worker 的业务入口。本机测试例外仅在 Worker 请求主机为 `localhost`/`127.0.0.1`、`PROOFREADING_LOCAL_LOOPBACK=1` 且目标**严格为** `http://127.0.0.1:8788/` 时开放；`wrangler dev --local` 使用，绝不部署此测试配置。
- `PROOFREADING_SIGNING_SECRET`：Worker 与后台共享的独立强随机密钥，仅通过 Worker secret 和后台机密管理配置；不能放入代码、浏览器或普通日志。支持轮换由后台实施时另行设计。
- Worker 每次查 D1 会话及 `approved` 状态；只有 `/api/proofreading/availability`、`/tasks`、`/tasks/:uuid` 被转发；POST 要求同源 Origin、JSON、200 KB 上限和 `X-Idempotency-Key`。无配置返回 503。
- Worker 对每次请求签发 HS256 JWT：`sub` 为数据库用户 id（字符串），`aud=proofreading-service`，`iat`、`exp`（60 秒）。后台 **必须** 验证签名、算法、受众、有效期及资源用户归属，不能接受浏览器自行提供的用户标头。后台务必限制非 Worker 来源；当前签名只用于服务间身份传递，不能替代网络边界。
- Worker 不转发浏览器 cookie，不跟随重定向，仅接受 JSON 回复（最多 1 MB）；所有响应 `no-store`。后台不得把密钥、原稿或异常堆栈写入普通日志。

## 接口（全部需要登录）

- `GET /api/proofreading/availability` → `{ "ready": true, "execution": "pi-skill-v1", "mode": "online", "models": { … }, "balance": { "total": "88.00", "currency": "CNY", "is_available": true } }`；`mode` 为 `online`（生产）/ `online-test` / `offline-partial-test` / `unavailable`。`balance` 为后台中转的 DeepSeek 账户余额（约 5 分钟缓存，任务结束后刷新；供应商故障时为 `null`，不影响 `ready`）。所有已登录用户可见；密钥仅存于后台。
- `GET /api/proofreading/tasks` → `{ "items": [{ "id": "UUID", "title": "…", "status": "queued|running|completed|partial|failed|cancelled" }] }`；只列当前用户。**历史保留策略：每用户仅保留最近 5 篇**，新提交时从早到晚自动删除更早任务（排队/运行中不删）；被删任务再次访问返回 404。
- `POST /api/proofreading/tasks`，JSON `{ "content": "…", "model": "deepseek/deepseek-flash" }`；`model` 可选，省略时采用 availability 的默认模型，指定时只接受 `models.available` 内的精确标识，否则返回 `invalid_model`。标题由服务端从首行/前缀提取；不要求稿件日期/拟刊日期。服务端保存不可变原文版本，幂等键按 **用户 + 键 + 请求内容 + 所选模型** 去重，返回 `{ "id": "UUID" }`。同键改稿或切换模型须拒绝；浏览器断线时不要重复提交扣费。
- `GET /api/proofreading/tasks/:uuid`（新执行器）→

  ```json
  {
    "id": "UUID", "title": "…", "status": "queued|running|completed|partial|failed|cancelled",
    "version_id": "…", "rule_version": "技能包 SHA-256", "model": "提供商/模型",
    "content": "原文",
    "created_at": "ISO-8601", "updated_at": "ISO-8601",
    "result_format": "pi-final-text-v1",
    "thinking_level": "实际使用的思考级别（如 medium；历史任务可能为空）",
    "result_text": "Pi 最终回答原文（逐字，含换行；completed/partial 时存在）",
    "usage": { "calls": 7, "totalTokens": 40700, "estimatedUsd": 0.06, "available": true },
    "stages": [{ "name": "Pi 读取技能参考文件", "status": "done|running|pending" }],
    "note": "partial 时说明执行未完成；不代表校对通过"
  }
  ```

  `created_at` / `updated_at` 为任务时间戳，前端据此显示已持续时长与完成用时；网页仅将实际执行阶段归并为四个展示阶段，不展示底层工具事件。非本人任务返回 404，不在响应中泄露归属。

  - `result_text` 不经任何过滤、合并或锚点验证，网页以 `textContent` + `pre-wrap` 原样展示。仅在 `completed` 后，前端从符合技能格式的错误行提取片段，为能在原稿中唯一逐字定位的片段加展示划线；匹配失败、重复或重叠则不划线，不修改意见或原稿。
  - `partial`：所需参考文件未完整读取、扫描未成功或已请求搜索失败。回答保留展示，状态与回答分开呈现。
  - `failed`：模型中断、输出截断（`model_output_truncated`）、无最终回答或会话配置异常；不得显示“无意见”。
  - `usage.available=false` 表示本次用量估算缺失，不代表任务失败。
- 历史结构化任务（旧执行器生成）仍返回 `issues` / `unverified` / `verified` / `sources` 字段，语义与旧契约一致，仅作历史兼容；新执行器不生成这些列表。
- 结果区只显示最终回答（新）或明确错误（旧）；不展示搜索材料、正确项、待核实清单或内部推理。展示划线仅使用现有返回字段，不新增 API 调用或模型成本。

## 后台初版与未完成项

仓库内已有可本地测试的 SQLite 任务队列、签名验签、版本锁定、原生 Pi 技能执行器及受控 TinyFish Search（不调用 Fetch、Agent 或 Browser）。执行器默认**不就绪**；仅显式启用 `PROOFREADING_ENABLE_OFFLINE_PARTIAL=1` 时允许去敏稿本机试运行。网页不限模型调用次数，按实际工具往返记录用量；无自动付费重试；POST 断线不重提。

联网仅 TinyFish Search、一次合并查询（2–3 条）；搜索材料作为不可信数据交给 Pi 自行判断，`sources`/`verified`/`unverified` 不再由新执行器产生。工具边界（只读规则快照、草稿写原稿、扫描脚本白名单、无 shell 注入）有测试覆盖，但尚非完整操作系统沙箱。

模拟模型与模拟搜索的端到端测试已验证执行链路；**真实校对质量尚未与本地同配置 Pi 对照**（见 `../校对服务落实方案.md` 阶段 B），不能宣称等价。生产所需用量/金额账本等尚未接通。

追问、采纳修改、BYOK、个人错题本、预算预留与结算、取消/重试、外部数据保存与加密备份仍未实现。上线前还必须完成真实模型回归、跨用户安全测试、搜索限额与费用控制及备份恢复演练。
