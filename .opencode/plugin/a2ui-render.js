/**
 * A2UI 渲染工具插件 (opencode plugin)。
 *
 * 把 [packages/protocol/src/templates.ts] 里的每个模板注册成一个 opencode 工具。
 * 模型不再手写 A2UI 协议文本 —— 它只调 `render_card` / `render_list` /
 * `render_form` / `render_confirm`,参数由 zod schema 约束。
 *
 * 数据怎么到前端: 工具的 `execute` **什么都不做**(只回一句确认)。真正的展开发生
 * 在后端 —— [packages/server/src/http/adapter/a2ui.ts] 在 ACP 事件流里认出这几个
 * 工具名,读 `tool_call_update.rawInput`(结构化对象,zod 已校验),交给
 * expandTemplate 展开成标准 envelope 推给客户端。
 *
 * 所以这里不需要跨进程通信: 插件跑在 opencode 进程内,参数顺着 ACP 通道自然流到
 * 后端。插件的职责只是「声明工具契约」。
 *
 * 前提: opencode 的 `--pure` 会跳过插件 —— 后端必须以 OPENCODE_PURE=false 启动
 * (见 env.ts 的注释)。
 *
 * 单一真源: schema 从 templates.ts 的 `args` 声明生成。加模板/改字段只动
 * templates.ts,这个文件不用碰。
 */

import { tool } from "@opencode-ai/plugin/tool";
// opencode 跑在 Bun 上,能直接 import 工作区里的 .ts —— 无需预编译,也就不会有
// 「插件里的 schema 和后端的模板定义漂移」的问题。
import { TEMPLATES } from "../../packages/protocol/src/templates.ts";

const z = tool.schema;

/**
 * 把一个 ArgSpec 声明翻译成 zod。`optional` 决定字段是否必填 —— 这是模型看到的
 * 唯一契约,写错了 zod 直接拦下并把错误回流给模型重试。
 */
function toZod(spec) {
  let base;
  switch (spec.kind) {
    case "string":
      base = z.string();
      break;
    case "number":
      base = z.number();
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "enum":
      base = z.enum(spec.values);
      break;
    case "stringArray":
      base = z.array(z.string());
      break;
    case "unknownArray":
      // 形状自由的数组(表格 rows: string[] 或对象都接)。归一化在后端做。
      base = z.array(z.unknown());
      break;
    case "record":
      // 附加数据是自由形状 —— 只约束到「对象」,内容由业务决定。
      base = z.record(z.string(), z.unknown());
      break;
    case "objectArray":
      base = z.array(z.object(buildShape(spec.fields)));
      break;
    default:
      base = z.unknown();
  }
  base = base.describe(spec.describe);
  return spec.optional ? base.optional() : base;
}

/** 一组 ArgSpec → zod raw shape。 */
function buildShape(args) {
  const shape = {};
  for (const [name, spec] of Object.entries(args)) {
    shape[name] = toZod(spec);
  }
  return shape;
}

/**
 * 每个模板生成一个工具。execute 是空操作 —— 渲染由后端在 ACP 事件流里完成
 * (见文件头注释)。返回的 output 是给**模型**看的确认,不是给用户看的 UI。
 */
function buildTools() {
  const tools = {};
  for (const spec of Object.values(TEMPLATES)) {
    tools[spec.toolName] = tool({
      description: spec.description,
      args: buildShape(spec.args),
      async execute(args, ctx) {
        // metadata 让这次调用在 opencode 侧的日志/TUI 里有个可读标题。
        ctx.metadata?.({ title: `渲染 ${spec.name}` });
        return {
          title: `已渲染 ${spec.name}`,
          // 明确告诉模型「UI 已经给用户看到了」,免得它再用文本把同样的内容复述
          // 一遍 —— 那会让用户看到重复内容。
          output:
            `已在用户界面渲染 ${spec.name}。用户现在能看到它了,` +
            `不要再用文字重复这张卡的内容。若卡上有按钮,等用户点击后你会收到对应事件。`,
        };
      },
    });
  }
  return tools;
}

export const server = async () => ({
  tool: buildTools(),
});
