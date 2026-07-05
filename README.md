# A2UI Chat — 基于 A2UI v0.9.1 协议的 AI 对话系统

一个完整可跑的 demo，演示 [A2UI 协议](https://a2ui.org/specification/v0.9.1-a2ui/) 如何让 AI Agent 通过流式 JSON 生成富交互 UI，而不是输出可执行代码。

```
用户输入 ──▶ 服务端（Fastify） ──▶ OpenAI 兼容 LLM
                  ▲ │
                  │ ▼ SSE: { createSurface | updateComponents | updateDataModel | deleteSurface }
                  │
   action ◀── React 渲染器（zustand store + 邻接表渲染）
```

## ✨ 已实现

- A2UI v0.9.1 四种信封消息（`createSurface` / `updateComponents` / `updateDataModel` / `deleteSurface`），完全按 [规范](https://a2ui.org/specification/v0.9.1-a2ui/) 落地
- 组件邻接表 + 渐进式渲染（前向引用降级为占位符，不崩溃）
- JSON Pointer（RFC 6901）数据绑定 + `ChildList` 模板迭代（含相对路径作用域）
- DynamicValue 求值：字面量 / `{path}` / `{call, args}` 函数调用三态
- 基础组件目录（Catalog）：Text / Image / Icon / Video / AudioPlayer / Row / Column / List / Card / Tabs / Divider / Modal / Button / TextField / CheckBox / DateTimeInput / ChoicePicker / Slider
- 内建函数：`required` / `regex` / `length` / `numeric` / `email` / `and` / `or` / `not` / `formatString` / `formatNumber` / `formatCurrency` / `formatDate` / `pluralize` / `openUrl`
- 输入组件双向绑定到本地 dataModel；Button `checks` 任一不通过时自动禁用
- 两种 action：服务端事件（POST /api/action 后流式回推下一波 envelope）+ 本地函数调用（如 `openUrl` 直接在浏览器执行）
- `sendDataModel: true` 时，action 自动附带客户端数据快照
- SSE 流式传输；前端 fetch + ReadableStream 解析（支持 POST body 启动流）
- 进程内会话历史；OpenAI 兼容接口（base URL / model 可配置）

## 📦 项目结构

```
packages/
├── protocol/   共享：A2UI 类型、JSON Pointer、DynamicValue 求值、内建函数
├── server/     Fastify + SSE + OpenAI SDK + 流式 JSON 切分
└── client/     React 18 + Vite + Zustand 渲染器
examples/
└── prompts.md  试用提示词
```

## 🚀 快速开始

### 1. 准备环境
- Node.js ≥ 18
- 包管理器：[pnpm](https://pnpm.io/) ≥ 9

### 2. 安装
```bash
pnpm install
```

### 3. 配置 LLM
```bash
cp .env.example packages/server/.env
# 编辑 packages/server/.env
#   OPENAI_API_KEY=...
#   OPENAI_BASE_URL=https://api.openai.com/v1   # 也支持 DeepSeek/GLM/智谱 等 OpenAI 兼容网关
#   OPENAI_MODEL=gpt-4o-mini
```

### 4. 启动
```bash
pnpm dev
```
- 前端：http://localhost:5173
- 后端：http://localhost:3001 （/health 自检）

### 5. 试一下
在左侧输入框，例如：
> 给我一个联系表单，要邮箱字段、留言、提交按钮。邮箱必须合法。

右侧会以流式方式渐进式构建 Card → Column → TextField + Button 结构；故意输错邮箱会让按钮变灰；改对后点击提交，服务端收到 action 后会再生成一个确认卡片。

更多用例见 [examples/prompts.md](examples/prompts.md)。

## 🔍 协议要点速览

每个服务端 → 客户端的消息是一个 JSON 信封：
```json
{ "version": "v0.9.1", "createSurface": { "surfaceId": "form_1", "catalogId": "..." } }
{ "version": "v0.9.1", "updateComponents": { "surfaceId": "form_1", "components": [
  { "id": "root", "component": "Card", "child": "col" },
  { "id": "col",  "component": "Column", "children": ["title", "input"] }
] } }
{ "version": "v0.9.1", "updateDataModel": { "surfaceId": "form_1", "path": "/x", "value": 1 } }
{ "version": "v0.9.1", "deleteSurface": { "surfaceId": "form_1" } }
```

用户与 UI 交互时（按按钮、提交表单），客户端发送 action：
```json
{
  "name": "submitContact",
  "surfaceId": "form_1",
  "sourceComponentId": "submit_btn",
  "timestamp": "2026-06-28T...",
  "context": { "email": "user@example.com" }
}
```

> 完整规范见：https://a2ui.org/specification/v0.9.1-a2ui/

## 🧪 调试 / 端到端验证

- 浏览器 Network → 选中 `/api/chat` 请求 → EventStream 标签可看到每条 envelope
- 浏览器控制台会打印 `[a2ui:write]` 表明输入组件触发了 dataModel 写回
- 服务端日志会逐条打印 envelope，便于和规范字段对照
- 故意构造一个不存在 id 的引用 → 前端会显示"…loading <id>"占位符而不崩溃

## ⚠️ 本期不包含

- 持久化会话（重启清空）
- 自定义 Catalog / 第三方组件包
- A2A / MCP 传输绑定（仅 SSE）
- v1.0 候选特性（actionResponse 等）
- 鉴权 / 多租户

## 📄 License

MIT
