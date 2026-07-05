import React from "react";
import { renderNode } from "../a2ui/renderer.js";
import { useA2UI, type ConversationItem } from "../a2ui/store.js";

function preview(value: unknown, max = 520): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function ToolCall({ item }: { item: Extract<ConversationItem, { type: "tool_call" }> }) {
  return (
    <div className="conversation-tool">
      <div className="conversation-tool-title">🔧 调用工具：{item.name}</div>
      <details>
        <summary>参数</summary>
        <pre className="conversation-json">{preview(item.args)}</pre>
      </details>
    </div>
  );
}

function ToolResult({ item }: { item: Extract<ConversationItem, { type: "tool_result" }> }) {
  if (item.error !== undefined) {
    return (
      <div className="conversation-tool conversation-tool-error">
        <div className="conversation-tool-title">✖ 工具失败：{item.name}</div>
        <details>
          <summary>错误</summary>
          <pre className="conversation-json">{preview(item.error)}</pre>
        </details>
      </div>
    );
  }
  return (
    <div className="conversation-tool conversation-tool-done">
      <div className="conversation-tool-title">✅ 工具完成：{item.name}</div>
      <details>
        <summary>结果</summary>
        <pre className="conversation-json">{preview(item.result)}</pre>
      </details>
    </div>
  );
}

function SurfaceBubble({ surfaceId }: { surfaceId: string }) {
  const surface = useA2UI((s) => s.surfaces[surfaceId]);

  if (!surface) {
    return <div className="conversation-system">Surface 已删除：{surfaceId}</div>;
  }

  const theme = surface.theme?.primaryColor
    ? ({ ["--a2ui-primary" as never]: surface.theme.primaryColor } as React.CSSProperties)
    : undefined;

  return (
    <section className="surface-card conversation-surface" style={theme}>
      <div className="surface-header">
        <span>{surface.theme?.agentDisplayName ?? "surface"} · {surfaceId}</span>
        <span>{Object.keys(surface.components).length} components</span>
      </div>
      {renderNode("root", { surface, trail: new Set() })}
    </section>
  );
}

function ConversationRow({ item }: { item: ConversationItem }) {
  switch (item.type) {
    case "user_message":
      return (
        <div className="conversation-row conversation-row-user">
          <div className="conversation-bubble conversation-user">{item.text}</div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="conversation-row conversation-row-agent">
          <div className="conversation-bubble conversation-agent">{item.text}</div>
        </div>
      );
    case "system_message":
      return <div className="conversation-system">{item.text}</div>;
    case "trace":
      return (
        <div className="conversation-row conversation-row-agent">
          <div className="conversation-trace">● {item.message}</div>
        </div>
      );
    case "tool_call":
      return (
        <div className="conversation-row conversation-row-agent">
          <ToolCall item={item} />
        </div>
      );
    case "tool_result":
      return (
        <div className="conversation-row conversation-row-agent">
          <ToolResult item={item} />
        </div>
      );
    case "error":
      return <div className="conversation-error">{item.code}: {item.message}</div>;
    case "surface":
      return (
        <div className="conversation-row conversation-row-agent">
          <SurfaceBubble surfaceId={item.surfaceId} />
        </div>
      );
  }
}

export function ConversationView() {
  const conversation = useA2UI((s) => s.conversation);
  const busy = useA2UI((s) => s.busy);

  if (conversation.length === 0) {
    return (
      <div className="conversation-empty">
        <h2>A2UI Agent</h2>
        <p>在下面输入请求。Agent 的思考摘要、工具调用、工具生成的 A2UI 卡片都会显示在这里。</p>
        <ul>
          <li>计算 123*456，并把结果展示成卡片。</li>
          <li>查询演示餐厅数据，并渲染成列表。</li>
          <li>给我一个联系表单，要邮箱字段和提交按钮。</li>
        </ul>
      </div>
    );
  }

  return (
    <div className="conversation-list">
      {conversation.map((item) => (
        <ConversationRow key={item.id} item={item} />
      ))}
      {busy ? <div className="conversation-system">…streaming</div> : null}
    </div>
  );
}
