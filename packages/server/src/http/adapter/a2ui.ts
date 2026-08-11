/**
 * A2UI 渲染适配器。在 agent 事件流里认出 UI 渲染工具的调用,把它的**结构化参数**
 * 展开成标准 A2UI envelope。
 *
 * 上游是 opencode 插件 [.opencode/plugin/a2ui-render.js] 注册的工具
 * (render_card / render_list / render_form / render_confirm)。模型调用它们时,
 * 参数经 zod 校验后以 `tool_call.args` 到达 —— 是**对象**,不是文本。所以这一层
 * 不需要任何文本解析: 没有围栏扫描、没有增量 JSON、没有跨 chunk 缓冲。
 *
 * 做三件事:
 *   1. 认出渲染工具的 tool_call → 展开成 `a2ui` 事件推给客户端
 *   2. **吞掉**这些工具的 tool_call / tool_result —— 用户看到的是渲染出来的卡片,
 *      不该再看到一条 "render_card" 工具调用记录。其他工具(read/bash/...)照常透传。
 *   3. 其余事件原样透传
 *
 * 下游(image-capture / transcript / SSE / 前端 store)完全不感知工具的存在 ——
 * 它们看到的仍是标准协议消息。
 */

import { expandTemplate, TOOL_TO_TEMPLATE } from "@a2ui/protocol";
import type { AgentEvent } from "../../agent/runner.js";

/**
 * surfaceId 生成器。
 *
 * withA2UIAdapter 每个请求一个实例,所以光用自增序号会跨轮次撞车 —— 第二轮的
 * "tpl_card_1" 会复用第一轮的 surface,把历史里那张卡改掉。带上实例 nonce 避免。
 *
 * nonce 不能只用 Date.now(): 同一毫秒内起的两个请求会拿到同一串。加一个进程内
 * 单调计数器保证唯一。
 */
let adapterInstanceCounter = 0;

function makeSurfaceIdGen(): (template: string) => string {
  const nonce =
    Date.now().toString(36) + "_" + (++adapterInstanceCounter).toString(36);
  let seq = 0;
  return (template) => `tpl_${template}_${nonce}_${++seq}`;
}

/**
 * 从工具参数里取出模型显式指定的 surfaceId(如果有)。
 *
 * 给同一个 surfaceId 再渲染一次即为「更新那张卡」: store 的 createSurface 对已存在
 * 的 id 幂等,updateComponents 按 id 覆盖,updateDataModel 以 path "/" 整根替换。
 *
 * 注意 surfaceId 不在模板的 zod schema 里 —— 它是渲染管线的实现细节,不该出现在
 * 模型的参数契约中。这里读它只是为将来「显式更新」留的口子。
 */
function pickSurfaceId(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const v = (args as Record<string, unknown>).surfaceId;
  return typeof v === "string" && v ? v : undefined;
}

/** 参数是否真的带了内容(不是 undefined,也不是空对象)。 */
function hasArgs(args: unknown): boolean {
  return (
    !!args &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    Object.keys(args as Record<string, unknown>).length > 0
  );
}

export async function* withA2UIAdapter(
  events: AsyncIterable<AgentEvent>
): AsyncIterable<AgentEvent> {
  const nextSurfaceId = makeSurfaceIdGen();
  /** 已被识别为渲染调用的 toolCallId —— 它们的 tool_result 也要吞掉。 */
  const swallowed = new Set<string>();

  for await (const ev of events) {
    if (ev.type === "tool_call") {
      const template = TOOL_TO_TEMPLATE[ev.name];
      if (!template) {
        yield ev;
        continue;
      }

      // 认出渲染工具 —— 吞掉这次调用本身,换成 a2ui 事件。
      swallowed.add(ev.id);

      // 参数为空说明这次调用没成功: zod 校验失败时,上游 mapper 发的是一条不带
      // args 的 late tool_call(见 acp-events.ts 的 completed/error 分支)。这种
      // 情况不能拿残缺参数硬渲染 —— 会给用户一张空卡。等 tool_result 里的错误
      // 信息到了再留 trace。
      if (!hasArgs(ev.args)) continue;

      const surfaceId = pickSurfaceId(ev.args) ?? nextSurfaceId(template);
      const envelopes = expandTemplate(template, ev.args, surfaceId);
      if (envelopes.length > 0) {
        yield { type: "a2ui", envelopes };
      } else {
        // 参数齐全但展开不出东西(builder 兜底后仍为空)。不发 a2ui,但也不能让
        // 用户什么都看不到 —— 留一条 trace 说明发生了什么。
        yield {
          type: "trace",
          message: `[a2ui] ${ev.name} 未能渲染出内容`,
        };
      }
      continue;
    }

    if (ev.type === "tool_result" && swallowed.has(ev.id)) {
      // 渲染工具的结果是给模型看的确认文案,对用户无意义 —— 吞掉。
      // 但工具真的报错了要让用户知道,否则 UI 没出来又毫无线索。
      if (ev.error) {
        yield { type: "trace", message: `[a2ui] 渲染失败: ${ev.error}` };
      }
      swallowed.delete(ev.id);
      continue;
    }

    yield ev;
  }
}
