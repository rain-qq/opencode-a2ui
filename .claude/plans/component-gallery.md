# Plan: A2UI 组件示例页面（动态 JSON 放映）

## 目标
新增一个前端页面，左侧列出 A2UI 组件示例，右侧预览。预览区**按时间顺序逐条回放 A2UI 信封 JSON**（`createSurface` / `updateComponents` / `updateDataModel` / `deleteSurface`），像放电影一样把组件渐进式"放映"出来，复用现有渲染器动态渲染组件。

## 设计要点

### 1. 页面入口（无路由，view 切换）
现有 `App.tsx` 是单页 chat，无 react-router。新增 `view: "chat" | "gallery"` 本地状态：
- chat 头部加按钮「组件示例」→ 切到 gallery
- gallery 头部加按钮「返回对话」→ 切回 chat
- 切换时调用 `useA2UI.getState().reset()` 清空，避免两视图状态串味

### 2. 复用全局 store（关键决策）
直接复用 `useA2UI` store + `applyEnvelope` + `renderNode`：
- 回放就是把 fixture 信封按时间逐条 `applyEnvelope` 到全局 store
- 渲染走 `renderNode("root", { surface, trail })`，与 chat 完全一致
- **输入控件双向绑定免费用**：`writeBack` 已绑定全局 store，所以表单校验、slider、checkbox 在预览里都能真实交互
- 代价：会写全局 store 的 conversation；但 gallery 不渲染 conversation，且切换时 reset，无副作用

（不另建本地 store，因为输入写回 `writeBack` 硬耦合全局 store，本地化需改 `bind.ts`/所有 input 组件，侵入太大。）

### 3. 布局（`ComponentGallery.tsx`）
```
┌─ 头部：A2UI 组件示例 · ▶/⏸ ⏭ ⟲  速度[1x]  3/12   [返回对话] ─┐
├──────────────┬──────────────────────────────────────────────┤
│ 左：示例列表  │ 右上：预览画布（A2UI 渲染区，device 框）         │
│  · 基础卡片   │                                              │
│  · 联系表单   ├──────────────────────────────────────────────┤
│  · 书籍列表   │ 右下：JSON 放映带 —— 全部信封列表，当前条高亮  │
│  · 设置面板   │       + 当前信封 pretty-printed 详情            │
│  · Tabs       │       点击某条 → seek 到该步                   │
│  · Modal      │                                              │
│  · 格式化     │                                              │
│  · openUrl    │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

### 4. 回放引擎（`usePlayback` hook）
- 入参：`envelopes`, `surfaceId`, `speed`
- 状态：`index`（已应用到第几条）、`playing`
- 播放：`setTimeout` 逐条 `applyEnvelope`，间隔 = baseInterval / speed
- `step()`：应用下一条并暂停
- `restart()`：`reset()` store，index 归 0，自动播放
- `seek(k)`：`reset()` 后应用 0..k，暂停于 k
- 选中示例：`reset()` + 自动播放

### 5. 示例 fixtures（`gallery/demos.ts`）
8 个示例，每个是一段信封序列（照真实流式输出拆成多条，体现渐进式 + 占位符降级）：

| # | 名称 | 演示点 |
|---|------|--------|
| 1 | 基础卡片 | Card→Column→Text 渐进出现，占位符→填充 |
| 2 | 联系表单（校验） | TextField + checks，按钮随邮箱合法性禁用；放映尾段模拟 `/email` 改写 |
| 3 | 书籍列表（ChildList） | `updateDataModel /books` + 模板迭代 |
| 4 | 设置面板 | CheckBox / Slider / ChoicePicker 写回 dataModel |
| 5 | Tabs 多页 | tabLabels + 多子页 |
| 6 | Modal 弹窗 | `open:{path}` + 放映中改 dataModel 让弹窗开/关 |
| 7 | formatString 格式化 | `${/user/firstName}` 插值 |
| 8 | openUrl 友情链接 | 本地函数 action，新窗口打开 |

fixtures 严格遵循协议（checks 用 `args:{value:{path}}`；按钮标签用 `text` 或 `child`）。

### 6. 样式（追加到 `theme.css`）
新增 `.gallery`、`.gallery-sidebar`、`.gallery-stage`、`.gallery-filmstrip`、`.gallery-toolbar`、`.filmstrip-item.active` 等，沿用现有 CSS 变量（暗色主题）。

## 改动文件
- **新增** `packages/client/src/gallery/demos.ts` — 8 个示例信封序列
- **新增** `packages/client/src/gallery/usePlayback.ts` — 回放 hook
- **新增** `packages/client/src/gallery/ComponentGallery.tsx` — 页面组件
- **改** `packages/client/src/App.tsx` — view 切换 + gallery 入口
- **改** `packages/client/src/theme.css` — gallery 样式

## 不做
- 不引 react-router（用本地 view 状态）
- 不改 `bind.ts` / 组件 / `renderer.tsx`（零侵入复用）
- 不接后端（纯前端 fixture 回放，离线可跑）
- 不持久化

## 验证
`pnpm dev` → 前端 5173 → 点「组件示例」→ 选示例自动放映 → 看渐进式渲染 + JSON 高亮同步 → 暂停/单步/拖速度/点 filmstrip seek → 表单输入真实交互（输错邮箱按钮变灰）。
