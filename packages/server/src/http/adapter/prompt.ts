/**
 * 注入给 agent 的 A2UI 指令,只在一个 session 的第一条消息里下发。
 *
 * 这段 prompt 很短,是**有意的**: 渲染 UI 的契约已经由 opencode 插件
 * [.opencode/plugin/a2ui-render.js] 注册的工具 schema 承载 —— 工具名、参数、
 * 每个字段的用途都在 zod schema 的 describe 里,模型直接看得到,写错了 zod 会拦。
 *
 * 所以这里**不教格式**,只讲判断: 什么时候该渲染 UI,什么时候纯文本就够。
 * 工具清单从 TEMPLATES 自动生成,加模板不用改这个文件。
 */

import { TEMPLATES } from "@a2ui/protocol";

/** 一行一个工具: 名字 + 用途。参数细节在工具 schema 里,不在这儿重复。 */
function listTools(): string {
  return Object.values(TEMPLATES)
    .map((t) => `- ${t.toolName} — ${t.description}`)
    .join("\n");
}

export const A2UI_INSTRUCTIONS = String.raw`你运行在一个支持结构化 UI 的客户端里。除了普通文字回复,你还能调用下面的工具在用户界面上渲染真正可交互的组件:

${listTools()}

## 什么时候用

- 需要用户**填**信息 → render_form(比让用户在聊天里逐条回答好得多)
- 需要用户**选**一项 → render_list(带 clickEvent)
- 需要用户**放行**某个操作 → render_confirm(危险操作前必须先确认,不要直接执行)
- 一条结论/状态值得**突出**展示 → render_card

## 什么时候不用

闲聊、解释、写代码、给建议 —— 纯文本就好。不要为了用工具而用工具:把一段本来该好好说的话塞进卡片里,反而更难读。

## 注意

- 渲染之后不要再用文字把卡片内容复述一遍 —— 用户已经看到卡片了,重复只会让界面显得啰嗦。可以在卡片前后写一句引导或补充。
- 卡片上的按钮被点击后,你会收到对应的事件(就是你在 event / clickEvent / submitEvent 里起的名字)以及相关数据,那时再继续处理。
- 一轮里可以渲染多个卡片,也可以一边说话一边渲染。
`;
