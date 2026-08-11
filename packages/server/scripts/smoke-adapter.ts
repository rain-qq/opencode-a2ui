/**
 * A2UI 渲染适配器的离线 smoke 测试。把合成的 AgentEvent 流灌进 withA2UIAdapter,
 * 打印结果。不需要真实 LLM 调用。
 *
 * 关注:
 *   1. 渲染工具的 tool_call → 展开成 a2ui 事件,且原 tool_call/tool_result 被吞掉
 *   2. 非渲染工具(read/bash/...)照常透传
 *   3. 参数残缺时不炸流
 *   4. surfaceId 不重复(除非模型显式指定)
 *
 * 运行:  cd packages/server && pnpm smoke
 */

import { withA2UIAdapter } from "../src/http/adapter/a2ui.js";
import type { AgentEvent } from "../src/agent/runner.js";

/** 一次渲染工具调用 + 它的结果,就是真实流里的样子。 */
function renderCall(
  id: string,
  name: string,
  args: unknown,
  result: unknown = { output: "已渲染" }
): AgentEvent[] {
  return [
    { type: "tool_call", id, name, args },
    { type: "tool_result", id, name, result },
  ];
}

const SCENARIOS: { name: string; events: AgentEvent[] }[] = [
  {
    name: "纯闲聊(无工具调用)",
    events: [
      { type: "session", opencodeSessionId: "ses_demo" },
      { type: "step_start" },
      { type: "text", text: "没问题,我尽量说简短些。" },
      { type: "step_finish", reason: "stop" },
      { type: "done" },
    ],
  },
  {
    name: "文字 + render_card + 文字",
    events: [
      { type: "text", text: "部署好了:\n\n" },
      ...renderCall("c1", "render_card", {
        title: "部署完成",
        description: "服务已发布到 **生产环境**。",
        footnote: "耗时 42s",
        actions: [{ label: "查看日志", event: "viewLogs", context: { id: "d1" } }],
      }),
      { type: "text", text: "还需要什么告诉我。" },
    ],
  },
  {
    name: "render_form(真实模型参数)",
    events: renderCall("f1", "render_form", {
      title: "联系表单",
      submitEvent: "submitContact",
      submitLabel: "提交",
      fields: [
        { name: "email", label: "邮箱", type: "email", required: true, placeholder: "请输入邮箱" },
        { name: "message", label: "留言", type: "text", minLength: 10, required: true },
      ],
    }),
  },
  {
    name: "render_list(可点击)",
    events: renderCall("l1", "render_list", {
      title: "经典科幻",
      clickEvent: "selectBook",
      items: [
        { id: "b1", title: "三体", subtitle: "刘慈欣", badge: "9.3" },
        { id: "b2", title: "沙丘" },
      ],
    }),
  },
  {
    name: "render_confirm",
    events: renderCall("k1", "render_confirm", {
      title: "确认删除分支?",
      message: "分支 `feature/old` 将被永久删除。",
      confirmEvent: "doDelete",
      cancelEvent: "abortDelete",
      context: { branch: "feature/old" },
    }),
  },
  {
    name: "非渲染工具照常透传",
    events: [
      { type: "tool_call", id: "r1", name: "read", args: { path: "a.ts" } },
      { type: "tool_result", id: "r1", name: "read", result: "file contents" },
    ],
  },
  {
    name: "渲染工具与普通工具混合",
    events: [
      { type: "tool_call", id: "b1", name: "bash", args: { cmd: "npm test" } },
      { type: "tool_result", id: "b1", name: "bash", result: "ok" },
      ...renderCall("c2", "render_card", { title: "测试通过" }),
      { type: "tool_call", id: "g1", name: "grep", args: { p: "foo" } },
      { type: "tool_result", id: "g1", name: "grep", result: "3 matches" },
    ],
  },
  {
    name: "多次渲染 -> surfaceId 不重复",
    events: [
      ...renderCall("m1", "render_card", { title: "第一张" }),
      ...renderCall("m2", "render_card", { title: "第二张" }),
    ],
  },
  {
    name: "显式 surfaceId -> 更新同一张卡",
    events: [
      ...renderCall("u1", "render_card", { surfaceId: "my_card", title: "第一版" }),
      ...renderCall("u2", "render_card", { surfaceId: "my_card", title: "第二版" }),
    ],
  },
  {
    name: "空参数 -> 不炸流",
    events: renderCall("e1", "render_card", {}),
  },
  {
    name: "zod 失败(late tool_call 无 args) -> 不渲染,只留 trace",
    events: [
      { type: "tool_call", id: "z1", name: "render_form" },
      { type: "tool_result", id: "z1", name: "render_form", error: "zod: fields is required" },
    ],
  },
  {
    name: "items 为空的 list -> 渲染空态",
    events: renderCall("e2", "render_list", { title: "空列表", items: [] }),
  },
  {
    name: "渲染工具报错 -> 留一条 trace",
    events: [
      { type: "tool_call", id: "x1", name: "render_form", args: { submitEvent: "s" } },
      { type: "tool_result", id: "x1", name: "render_form", error: "zod: fields is required" },
    ],
  },
];

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** 一条 envelope 的单行摘要。 */
function describeEnvelope(e: any): string {
  if (e.createSurface) {
    const sdm = e.createSurface.sendDataModel ? " sendDataModel" : "";
    return `createSurface(${e.createSurface.surfaceId})${sdm}`;
  }
  if (e.updateComponents) {
    const comps = e.updateComponents.components ?? [];
    return `updateComponents ${comps.length} 个: ${comps.map((c: any) => c.component).join("+")}`;
  }
  if (e.updateDataModel) {
    const keys = Object.keys(e.updateDataModel.value ?? {}).join(",");
    return `updateDataModel path=${e.updateDataModel.path} keys=${keys}`;
  }
  return "?";
}

(async () => {
  const seenSurfaces: string[] = [];
  let leaks = 0;

  for (const sc of SCENARIOS) {
    console.log("\n=== " + sc.name + " ===");
    for await (const ev of withA2UIAdapter(fromArray(sc.events))) {
      if (ev.type === "a2ui") {
        console.log("  a2ui: " + ev.envelopes.length + " 条 envelope");
        for (const e of ev.envelopes as any[]) {
          if (e.createSurface) seenSurfaces.push(e.createSurface.surfaceId);
          console.log("    - " + describeEnvelope(e));
        }
      } else if (ev.type === "tool_call") {
        // 渲染工具不该以 tool_call 形式漏给用户。
        if (ev.name.startsWith("render_")) leaks++;
        console.log(
          "  tool_call: " + ev.name + (ev.name.startsWith("render_") ? "  <-- LEAK" : "")
        );
      } else if (ev.type === "tool_result") {
        if (ev.name.startsWith("render_")) leaks++;
        console.log(
          "  tool_result: " + ev.name + (ev.name.startsWith("render_") ? "  <-- LEAK" : "")
        );
      } else if (ev.type === "text") {
        console.log("  text: " + JSON.stringify(ev.text.slice(0, 50)));
      } else if (ev.type === "trace") {
        console.log("  trace: " + ev.message);
      } else {
        console.log("  " + ev.type);
      }
    }
  }

  // 自动生成的 surfaceId 必须唯一;显式指定的(my_card)本就该重复两次。
  const auto = seenSurfaces.filter((s) => s.startsWith("tpl_"));
  const dupes = auto.filter((s, i) => auto.indexOf(s) !== i);
  console.log("\n--- 汇总 ---");
  console.log("自动 surfaceId: " + auto.length + " 个, 重复 " + dupes.length + " 个");
  console.log("显式 surfaceId: " + seenSurfaces.filter((s) => !s.startsWith("tpl_")).join(", "));
  console.log(leaks === 0 ? "✓ 渲染工具无泄漏" : `✗ ${leaks} 处泄漏`);
  if (leaks > 0 || dupes.length > 0) process.exitCode = 1;
})();
