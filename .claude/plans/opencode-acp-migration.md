# 后端 opencode 链路迁移到 ACP 协议

## 结论：可行，且推荐做

已实测 `opencode acp` (v1.17.13) 是一个 **stdio JSON-RPC 2.0** 对端（不是 HTTP——`--port/--hostname/--cors` 是 yargs 全局参数的噪音，stdin EOF 即退出）。已确认的协议面：

- `initialize` → `protocolVersion:1`，`agentCapabilities`：`loadSession:true`、`mcpCapabilities:{http,sse}`、`promptCapabilities:{embeddedContext,image}`、`sessionCapabilities:{close,fork,list,resume}`，`authMethods:[...]`
- `session/list` → `{sessions:[{sessionId,cwd,title,updatedAt}]}`（就是现有 `opencode run` 留下的同一批 `ses_...` 会话——**ACP session 即 opencode session**）
- `session/load` 需 `{sessionId, cwd, mcpServers:[]}`
- `session/prompt` 需 `{sessionId, prompt:[...]}`（prompt 是数组）

迁移后多轮续接从「从首个 NDJSON 事件里抓 `sessionID` 再传 `--session`」变成原生 `session/load`，并多出 list/fork/resume/close 能力。

## 范围决策（推荐方案 A，方案 B 作为后续）

- **方案 A（本次实施，传输层替换）**：用 `opencode acp` 的 JSON-RPC 长连接对端替换现有 `opencode run` NDJSON 子进程链路。**`AgentEvent` 公共类型与 SSE 对外契约完全不变**，因此 `http/app.ts`、`http/adapter/a2ui.ts`、`http/sse.ts`、整个 `client/`、`protocol/` 都不动。Skill/MCP/Agent 选择器仍走 `buildSelectionPrefix()` 的 prompt 注入（可用、非破坏）。
- **方案 B（后续可选，不在本次）**：把选择器从 prompt 注入迁到 ACP 原生参数（`session/new` 的 `mcpServers`、agentId），并开放 `session/list`/`fork`/`resume` 的 UI。会动到 `app.ts`、`registry.ts` 选择器 wire format 与 `client/`。A 的 `AgentEvent` 表面已稳定，后续做 B 只增不改，A 不浪费。

本次只做 A。需要 B 时再说一声，独立排期。

## 现状链路（要被替换的部分）

- `serve.ts` → `startOpencodeServer()`（serve-manager.ts）拉起长驻 `opencode serve`，把 URL 写回 `ENV.OPENCODE_SERVER_URL`
- `client.ts` 每轮 `spawn opencode run --format json [--attach <url>] [--session <id>]`，逐行解析 NDJSON
- `events.ts` `OpencodeEvent`/`parseOpencodeLine`/`stripThinking`
- `runner.ts` `mapOpencodeEvent` 把 NDJSON 事件映射成 `AgentEvent`；从首个事件抓 `sessionID` 存进 session store，后续 `--session` 续接
- `session/store.ts` 持 `opencodeSessionId`

## 目标链路

- `serve.ts` → `startAcpPeer()` 拉起**一个**长驻 `opencode acp` 子进程，做一次 `initialize` 握手 + `notifications/initialized`，暴露 `AcpClient` 单例
- 每个 A2UI 会话：首turn 用 `session/new`（若无存储 id）或 `session/load`（有存储 id）拿到/恢复 `sessionId`，存进 store
- 每轮：`session/prompt {sessionId, prompt:[{type:"text",text}]}`，**异步迭代其 `session/update` 通知流**，逐个映射成 `AgentEvent` yield
- `session/cancel` 用于中断在途 prompt（接 SSE 断开 / 客户端取消）
- Windows 进程树清理复用 `killProcessTree`（taskkill /T /F）

## 文件改动清单

### 改动（server 运行时核心）
1. **`opencode/acp-client.ts`（新建）** — JSON-RPC 2.0 stdio 客户端：
   - 持久 `spawn opencode acp [--pure] [--print-logs]` 子进程，stdio 全管道（stdin 写、stdout 读 NDJSON）
   - 请求/响应按 `id` 关联；通知路由到当前在途 prompt 的迭代器
   - 方法：`initialize`、`session/new`、`session/load`、`session/list`、`session/prompt`（返回 `AsyncIterable<AcpNotification>`）、`session/cancel`、`session/close`
   - 复用 `client.ts` 现有的「队列 + resolveNext」流式骨架（已验证可用）
2. **`opencode/acp-events.ts`（新建，替代 `events.ts`）** — ACP 事件类型 + `mapAcpEvent(): AgentEvent[]`。事件词汇按 ACP 规范：`TextMessageStart/Content/End`、`ToolCallStart/Content/End`、`ReasoningStart/Content/End`、`Finish`、`Usage`、`Error`。**`stripThinking` 预计可删**（ACP 有显式 Reasoning 通道；MiniMax 的 `reasoning_split` 走 Reasoning 事件而非塞进 text）。保留一个降级路径以防个别 provider 仍往 text 里塞 CoT
3. **`opencode/serve-manager.ts`（重命名为 `acp-peer-manager.ts`）** — `startOpencodeServer()` → `startAcpPeer()`：spawn `opencode acp`，等 `initialize` 响应（不再是 "listening on" 行）即视为就绪。**复用** `killProcessTree`/`stopOpencodeServer`（改名 `stopAcpPeer`）。bootstrap 失败不再静默降级——ACP 是唯一传输，失败则在首个 turn 报 `OPENCODE_SPAWN_FAILED`（与现有 ENOENT hint 一致）
4. **`agent/runner.ts`** — 重写 `runAgent`：取/建 ACP `sessionId`（有存储 id → `session/load`，否则 `session/new`），发 `session/prompt`，把通知流经 `mapAcpEvent` 映射成 `AgentEvent` yield。**`AgentEvent` 联合类型、`RunAgentInput`、`RunAgentOptions` 签名不变**；`firstMessagePrefix` 仍生效（拼到 prompt text 前缀）
5. **`session/store.ts`** — `opencodeSessionId` 字段语义不变（同一 `ses_...` 值，现在通过 `session/load` 续接）。可选重命名为 `acpSessionId`（纯命名，低风险）
6. **`env.ts`** — 删 `OPENCODE_SERVER_*`（PORT/HOST/URL/ENABLED/STARTUP_TIMEOUT）。保留 `OPENCODE_BIN`/`WORKDIR`/`MODEL`/`AGENT`/`PURE`/`PRINT_LOGS`/`HEARTBEAT_MS`。`OPENCODE_AUTO` → 映射到 ACP session 的 `permissionMode`（auto=`auto`/`acceptEdits`，实现时确认取值）。新增 `OPENCODE_ACP_STARTUP_TIMEOUT_MS`
7. **`serve.ts`** — `startOpencodeServer()`→`startAcpPeer()`，peer 即长驻进程；清理接线不变
8. **`.env.example`** — 同步移除 `OPENCODE_SERVER_*`，加 `OPENCODE_ACP_*`

### 不动（因 `AgentEvent` 表面保持不变）
- `http/app.ts`、`http/adapter/a2ui.ts`、`http/sse.ts`、`http/adapter/prompt.ts`、`agent/registry.ts`、`index.ts`（CLI 驱动）、整个 `packages/client`、`packages/protocol`

## 实施步骤

1. **先做一次实时 prompt 探测**确认两件事（写代码前 5 分钟）：
   - `session/new` 的确切响应与是否需要 `mcpServers`/其它必填项（实测时它在 18s 内未回响应——需查清是冷启 bootstrap 慢、还是缺 `notifications/initialized`、还是参数问题；若 `session/new` 行为异常，**始终用 `session/load` 兜底**：首turn 也走 `load`，或在 `session/list` 里取一个，因为 `loadSession:true`）
   - `session/prompt` 的流式通知方法名（应为 `notifications/session/update`，payload `{sessionId, event:{...}}`）与 opencode 实际发出的 event `type` 词汇（确认 `TextMessageStart` 等命名、以及 MiniMax interleaved reasoning 是否走 Reasoning 事件）
2. 新建 `acp-client.ts` + `acp-events.ts`，先离线单测「initialize → session/list → session/prompt」能跑通并映射出 `AgentEvent`
3. 重写 `runner.ts`，跑通「A2UI 发消息 → 收到 text/tool/a2ui 事件」端到端
4. 重写 `serve-manager.ts`→`acp-peer-manager.ts`、改 `serve.ts`、`env.ts`、`.env.example`
5. 验证：`pnpm serve` 起服务，前端 `/api/chat` 多轮对话；确认 A2UI envelope（```a2ui fence）仍被 `a2ui.ts` 正确切出；确认 `session/cancel` 在 SSE 断开时生效；确认 Windows 退出无 ghost 进程
6. 删 `client.ts`/`events.ts`（NDJSON `run` 路径整体下线——ACP 是唯一目标，不保留双链路）

## 风险与回退

- **`session/new` 行为未完全确认**：步骤 1 解决；若确有问题，用「始终 `session/load`（首 turn 用占位/或 `list` 取一个）」兜底，不影响整体架构
- **ACP event 词汇与假设不符**：步骤 1 实测修正 `mapAcpEvent`；保留 `stripThinking` 降级分支以防 provider 仍往 text 塞 CoT
- **auth**：项目已用 apiKey 配置 minimax provider，`session/prompt` 可直接跑，无需 `authenticate`。若遇到需 `opencode auth login` 的 provider，ACP 会回 `authMethods`——v1 不做 auth UI，仅把「需要认证」作为 `error` 事件上抛
- **回退**：改动集中在 `opencode/` + `runner.ts` + `serve.ts` + `env.ts`，git 可整体 revert；`http/` 与 `client/` 不受影响
