# 基于 ACP 协议集成 Skill / MCP / 知识库 / 子 Agent

> 目标：把 A2UI 的插件选择从「prompt 前缀注入」(`buildSelectionPrefix`) 迁到 ACP 原生机制。
> 前置：后端 opencode 链路已完成 ACP 迁移（见 [opencode-acp-migration.md](opencode-acp-migration.md)），`AgentEvent` 表面不变。
> 本文所有 ACP 参数形状均经实测（opencode acp v1.17.13，读 zod 校验报错得出）。标 **TBD** 的项需一次 probe 确认。

---

## 0. 现状回顾（要被替换的部分）

- 选择器（[AgentPicker.tsx](packages/client/src/agent/AgentPicker.tsx)）三按钮 Agents/Skills/MCPs，多选，存 `{agents, skills, mcps}: string[]`。
- 后端 [registry.ts](packages/server/src/agent/registry.ts) 是**静态数组**，`GET /api/agents` 吐出。
- 提交时 `selection` 挂在 POST body；[app.ts](packages/server/src/http/app.ts) 用 `buildSelectionPrefix()` 拼成 `[Active Skills: ...] [Active MCPs: ...] [Active Agents: ...]` 前缀，塞进 message。
- 即：选择信息走「自然语言提示」，模型自己解读。opencode 对这些选择一无所知，没有真正的工具/资源加载。

---

## 1. ACP 原生集成点总览

| 插件类型 | ACP 机制 | 注入位置 | 作用域 | 确认状态 |
|---|---|---|---|---|
| **MCP 服务器** | `session/new` 的 `mcpServers[]` 参数 | 会话创建时 | **会话级**（创建时固定） | ✅ 已确认形状 |
| **知识库 / 上下文** | `session/prompt` 的 `prompt[]` 里 `resource`/`resource_link` 部件 | 每轮 prompt | **每轮** | ✅ 已确认形状 |
| **Skills** | `available_commands_update` 通知（目录）+ 模型自行调用 | 模型 decide | **全局**（opencode 配置发现） | ✅ 目录已确认；**force-enable TBD** |
| **子 Agent / 模式** | `session/new` 返回的 `configOptions`（model/mode） | 会话配置 | **会话级** | ✅ configOptions 已确认；**切换方法 TBD** |

**核心张力（必须先决策）**：MCP 与 Agent 是**会话级**参数（在 `session/new` 时固定）。当前 A2UI 一个会话内多轮复用同一 opencode session（`session/load`）。若要让用户**每轮**改 MCP/Agent，有三条路：

- **(A) 会话级 + 切换即新建会话**：改 MCP/Agent 选择 → 丢弃旧 opencode session、`session/new` 一个新的。丢失多轮历史。UX 差。
- **(B) 找到 ACP 的会话配置更新方法**（疑似 `session/update` 请求 / `session/configure`）**TBD**：能在已有 session 上热更新 mcpServers/mode。最优，待 probe。
- **(C) 配置驱动 + 提示**：MCP/Agent 写死在 `opencode.jsonc`（全局生效），picker 只做「本次建议用 X」的提示注入（退回现状，但 MCP 真的被 opencode 加载）。最稳，无 per-turn 灵活性。

**建议**：先 probe (B)。若 (B) 存在 → 全部走原生；若不存在 → MCP/Agent 走 (C)（配置驱动），知识库/Skills 走原生 per-turn。

---

## 2. MCP 服务器集成

### 2.1 ACP 形状（已确认）

`session/new` 的 `mcpServers` 是数组，每项是 stdio / http / sse 的联合（zod 字段：`name, type, command, args, env, url, headers`）：

```jsonc
// stdio MCP（本地进程）
{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "xxx" } }

// 远程 http MCP（streamable http）
{ "name": "kb-http", "type": "http", "url": "https://kb.example.com/mcp", "headers": [["Authorization","Bearer xxx"]] }

// 远程 sse MCP
{ "name": "kb-sse", "type": "sse", "url": "https://kb.example.com/sse" }
```

> `headers` 是 `[string,string][]` 元组数组（MCP 标准）。`agentCapabilities.mcpCapabilities:{http,sse}` 印证远程两类都支持；stdio 为默认（无 `type`）。

### 2.2 A2UI 对接

- **registry.ts** 升级：从 `string[]` 静态数组 → 带完整定义的注册表。每条 MCP 项含 `{id, name, transport:"stdio"|"http"|"sse", command?, args?, env?, url?, headers?}`。来源：opencode 配置文件（`opencode.jsonc` 的 `mcp` 段）反序列化 + A2UI 自定义补充。
- **picker**：MCPs 按钮从 registry 拉 `[{id,name}]`，多选存 `selection.mcps: string[]`（仍是 id 数组，前端不变）。
- **wire format**：POST body 的 `selection.mcps` 保持 `string[]`（前端零改动）；**后端**用 id 去 registry 查出完整定义，组装成 `mcpServers[]`。
- **runner.ts** `resolveSessionId` → `session/new` 时传入 `mcpServers`（仅首 turn 新建会话时生效；见 §1 张力）。
- **GET /api/agents**：返回结构化 registry（含 MCP 定义），供前端展示 + 后端自查。

### 2.3 关键限制

- `mcpServers` 只在 `session/new` 生效。已存在的 session 用 `session/load` 续接时**改不了** MCP 集合 → 受 §1 决策约束。
- MCP server 的生命周期由 opencode 管理（stdio 进程的拉起/退出），A2UI 不直接管，省了 `killProcessTree` 的麻烦。

---

## 3. 知识库 / 上下文集成

### 3.1 ACP 形状（已确认）

`session/prompt` 的 `prompt` 是部件数组，除 `text` 外还有（zod：`type ∈ {text,image,audio,resource_link,resource}`）：

```jsonc
[
  { "type": "text", "text": "根据以下知识回答：..." },
  { "type": "resource_link", "name": "产品手册", "uri": "file:///data/docs/manual.md" },
  { "type": "resource_link", "name": "FAQ", "uri": "kb://faq/returns" },
  { "type": "resource", "name": "片段", "uri": "mem://note-1", /* + blob/data 内联 */ }
]
```

- `resource_link`：**引用**（按 URI 指向资源）—— 文件、MCP resource、自定义 scheme。轻量，opencode 按 URI 拉取。
- `resource`：**内联**资源（带 blob）。
- `promptCapabilities.embeddedContext:true` 印证这是正式机制。

### 3.2 三种「知识库」形态映射

| 知识库形态 | ACP 集成方式 |
|---|---|
| 本地文件/文档目录 | `resource_link` + `file://` URI（每轮附相关文件） |
| 外部 RAG / 向量库 | 包成 **MCP server**（暴露 `resources` 原语），opencode 自动可读；或 http MCP 直接挂 §2 |
| 会话级笔记/片段 | `resource` 内联（小）或 `resource_link` + `mem://`（若 opencode 支持） |

### 3.3 A2UI 对接

- **picker 新增第 4 桶「知识」**：`selection.knowledge: {uri, name}[]` 或 `{type:"text"|"file"|"ref", ...}[]`。前端新增触发按钮（沿用现有下拉多选模式）。
- **wire format**：POST body 增 `selection.knowledge`。
- **runner.ts** `sessionPrompt`：把 `selection.knowledge` 映射成 `resource`/`resource_link` 部件，**拼到 `prompt[]` 前面**（每轮生效，无会话级张力）。`message` 仍是 `text` 部件。
- **registry**：可选维护「知识源目录」（命名 URI → 实际路径），供 picker 下拉选择。

### 3.4 优势

- **每轮**生效，不受会话级限制（与 MCP/Agent 不同）。
- 模型显式拿到上下文，不再是塞进 prompt 文本里让模型猜。

---

## 4. Skills 集成

### 4.1 ACP 形状（已确认）

每次 `session/prompt` 开头，opencode 发 `available_commands_update` 通知：

```jsonc
{ "sessionUpdate": "available_commands_update",
  "availableCommands": [ {"name":"web-search","description":"..."}, {"name":"pdf","description":"..."} ] }
```

即 opencode 已发现的 skill/命令目录（来自 plugins、`.opencode/skills/`、`~/.config/opencode/skills/`）。**模型在 turn 内自行决定调用哪个 skill**（作为命令/工具）。

### 4.2 关键事实

- Skill 的**发现与可用性由 opencode 配置决定**，客户端无法「注入一个 opencode 不认识的 skill」。
- **未确认是否存在「per-turn 强制启用某 skill」的参数**（**TBD**，需 probe `session/new`/`session/prompt` 是否接受 active-skills 之类）。若不存在，picker 选 skill 只能是「提示模型优先用 X」。

### 4.3 A2UI 对接

- **registry 动态化**：`GET /api/agents` 可改为从 ACP `available_commands_update`（或 opencode 配置）**实时拉取** skill 目录，替换静态数组。第一次 turn 后即有数据。
- **picker Skills 按钮**：展示真实可用 skill 列表（name+description），多选。
- **wire format + runner**：
  - 若 probe 到 force-enable 机制 → 原生传入。
  - 否则 → 保留「提示注入」：把选中的 skill name 拼成 prompt 文本前缀（`Prefer using the skill: web-search`）。**这是唯一仍走提示注入的插件类型**，但因 skill 确实存在于 opencode，模型能真正调用（比现状「opencode 毫无感知」强）。

### 4.4 备注

- 可在 `opencode.jsonc` 的 `skills`/`plugins` 段定义项目级 skill，ACP 自动发现 → registry 自动反映，无需改 A2UI 代码。

---

## 5. 子 Agent / 模式集成

### 5.1 ACP 形状（部分确认）

`session/new` 返回 `configOptions`：

```jsonc
"configOptions": [
  { "id":"model", "type":"select", "currentValue":"minimax-tokenplan/minimax-m3", "options":[...] },
  { "id":"mode",  "type":"select", "currentValue":"build", "options":[
      {"value":"build","description":"The default agent. Executes tools based on configured permissions."},
      {"value":"plan","description":"Plan mode. Disallows all edit tools."}
  ]}
]
```

- `mode`（build/plan）= opencode 内置 agent 选择器。自定义 subagent 在 `opencode.jsonc` 的 `agents`/`.opencode/agent/*.md` 定义，**预期会作为额外 `mode`/`agent` 选项出现在 configOptions**（待验证自定义 agent 是否真的进 configOptions）。
- **`session/new` 接受但忽略 `agent`/`mode` 键**（实测传入 `mode:"plan"`，返回仍 `currentValue:"build"`）→ 选择必须在创建后用**配置更新方法**改。

### 5.2 待确认（一次 probe）

`session/update`（**请求**形式，与同名通知不冲突）/ `session/configure` / `session/setOption` 哪个能热改 `configOptions`。**TBD**。

### 5.3 A2UI 对接

- **registry**：`GET /api/agents` 返回 configOptions 解析出的 agent/mode 列表（从首次 `session/new` 缓存）。
- **picker Agents 按钮**：展示 mode/agent 选项，**单选**（agent 是互斥的，不同于 skills/mcps 多选）。
- **runner.ts**：拿到 selection.agent → 在 session 创建后调配置方法设置；受 §1 张力约束（会话级）。
- **过渡方案**（probe 前可用）：agent/mode 写在 `opencode.jsonc`，picker 的 Agents 桶暂时保留提示注入或下线，等 §5.2 确认后切原生。

---

## 6. 会话级 vs 每轮 — 决策矩阵

| 插件 | 原生作用域 | 每轮切换需求 | 推荐路径 |
|---|---|---|---|
| MCP | 会话级（session/new） | 中（用户会想加减） | probe 热更新方法；无则 (C) 配置驱动 |
| 知识库 | 每轮（prompt 部件） | 高 | 原生 per-turn，无张力 |
| Skills | 全局（opencode 发现） | 低（模型自选） | 目录实时拉取；选中=提示 |
| Agent/Mode | 会话级（configOptions） | 中 | probe 热更新方法；无则 (C) 配置驱动 |

---

## 7. 分阶段实施计划

### Phase 0 — 补 probe（半天）
1. 确认 §5.2 的会话配置更新方法（`session/update` 请求等）。
2. 确认 §4.2 是否有 per-turn skill 启用参数。
3. 确认自定义 agent（`opencode.jsonc` `agents`）是否进 `configOptions`。
4. 更新 [a2ui-acp-migration.md](../../C:/Users/Rain/.claude/projects/d--workspace-A2UI/memory/a2ui-acp-migration.md) 记忆。

### Phase 1 — 知识库（每轮，无张力，最先做）
- picker 加「知识」桶；wire format 增 `selection.knowledge`；runner `sessionPrompt` 拼 `resource`/`resource_link` 部件。
- registry 加知识源目录。
- 验证：附 `file://` resource_link，确认模型读到内容。

### Phase 2 — MCP 原生
- registry 升级为结构化 MCP 定义；从 `opencode.jsonc` 反序列化。
- runner `session/new` 传 `mcpServers`（首 turn）。
- 决策 §1：(B) 热更新 or (C) 配置驱动 + 提示。
- 验证：挂一个 stdio MCP（如 filesystem），模型调用其工具。

### Phase 3 — Skills 目录实时化
- `GET /api/agents` 从 `available_commands_update` 缓存 skill 目录。
- picker Skills 按钮展示真实目录。
- 选中 skill → 提示注入（或原生，若 Phase 0 找到机制）。

### Phase 4 — Agent/Mode 原生
- registry 吐 configOptions；picker Agents 改单选。
- runner 用 §5.2 方法设置 mode/agent。
- 下线 `buildSelectionPrefix`（除 skill 提示外全部移除）。

---

## 8. 文件改动预估（全部完成后）

| 文件 | 改动 |
|---|---|
| [registry.ts](packages/server/src/agent/registry.ts) | 静态数组 → 结构化（MCP 定义、知识源、configOptions 缓存）；可从 opencode.jsonc 反序列化 |
| [app.ts](packages/server/src/http/app.ts) | `buildSelectionPrefix` 仅保留 skill 提示；其余选择走结构化参数 |
| [runner.ts](packages/server/src/agent/runner.ts) | `session/new` 传 mcpServers；`sessionPrompt` 拼 knowledge 部件；agent/mode 设置 |
| [acp-client.ts](packages/server/src/opencode/acp-client.ts) | 增 `sessionConfigure`/`sessionUpdate`（若 Phase 0 确认）；暴露 `available_commands` 缓存 |
| picker ([AgentPicker.tsx](packages/client/src/agent/AgentPicker.tsx)) | 加「知识」桶；Agents 改单选；Skills/MCPs 从结构化 registry 展示 |
| [store.ts](packages/client/src/a2ui/store.ts) | `selection` 增 `knowledge`；agents 改单值 |
| [transport.ts](packages/client/src/a2ui/transport.ts) | wire format 增 knowledge |

`AgentEvent` 与 SSE 表面**仍不变** —— 插件集成只影响「session 怎么建 / prompt 怎么拼」，不影响事件流。

---

## 9. 风险

- **会话级张力**（§1）：若 ACP 无热更新方法，MCP/Agent 的 per-turn 切换要么丢历史要么降级提示。需在 Phase 0 定调。
- **MCP server 启动失败**：opencode 挂 stdio MCP 失败时应 surfce 到 `error` 事件（当前 `session/new` 可能直接报错或静默跳过，待验证）。
- **权限**：MCP 工具调用可能触发权限请求（ACP 客户端需应答，否则 hang）。§0 迁移时 read 工具自动通过，但 MCP 工具未必 —— 需 probe 权限流。
- **registry 来源**：从 `opencode.jsonc` 反序列化需处理 JSONC（注释）；opencode 配置 schema 可能变。
