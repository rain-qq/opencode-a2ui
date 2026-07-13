import React, { useState } from "react";
import { renderNode } from "../a2ui/renderer.js";
import { MarkdownView } from "../a2ui/Markdown.js";
import { useA2UI, type ConversationItem } from "../a2ui/store.js";
import { ToolStep } from "./ToolStep.js";

type ToolCall = Extract<ConversationItem, { type: "tool_call" }>;
type ToolResult = Extract<ConversationItem, { type: "tool_result" }>;

/**
 * Collapsible "思考过程" block for streamed reasoning. Auto-expands while it's
 * the live (streaming) last item so the user sees the model thinking in real
 * time, then collapses to a one-line header once the turn moves on (Coze-style).
 */
function ReasoningBlock({
  text,
  live,
}: {
  text: string;
  live: boolean;
}) {
  const [manual, setManual] = useState<null | boolean>(null);
  const open = manual ?? live;
  return (
    <div className={"reasoning" + (open ? " open" : "")}>
      <button
        type="button"
        className="reasoning-header"
        onClick={() => setManual((m) => (m === null ? !open : null))}
        aria-expanded={open}
      >
        <span className="reasoning-icon">💭</span>
        <span className="reasoning-title">思考过程</span>
        {live && <span className="reasoning-live">思考中…</span>}
        <span className={"reasoning-chevron" + (open ? " open" : "")} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="reasoning-body">
          <MarkdownView content={text} />
        </div>
      )}
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

type RenderGroup =
  | { kind: "item"; item: ConversationItem }
  | { kind: "tool"; call?: ToolCall; result?: ToolResult };

/**
 * Merge each tool_call with its matching tool_result (by callId) into a single
 * render group, and drop the now-redundant tool_result rows. tool_call is
 * emitted before tool_result in the stream, so by the time we reach a result
 * its callId is already rendered as part of a ToolStep.
 */
function buildGroups(items: ConversationItem[]): RenderGroup[] {
  const resultByCall = new Map<string, ToolResult>();
  for (const it of items) {
    if (it.type === "tool_result") resultByCall.set(it.callId, it);
  }
  const renderedCalls = new Set<string>();
  const groups: RenderGroup[] = [];
  for (const it of items) {
    if (it.type === "tool_call") {
      renderedCalls.add(it.callId);
      groups.push({ kind: "tool", call: it, result: resultByCall.get(it.callId) });
    } else if (it.type === "tool_result") {
      if (renderedCalls.has(it.callId)) continue;
      groups.push({ kind: "tool", result: it });
    } else {
      groups.push({ kind: "item", item: it });
    }
  }
  return groups;
}

function GroupRow({ group, isLast, busy }: { group: RenderGroup; isLast: boolean; busy: boolean }) {
  if (group.kind === "tool") {
    const live = isLast && busy && !group.result;
    return <ToolStep call={group.call} result={group.result} key={(group.call ?? group.result)!.id} />;
  }
  const item = group.item;
  switch (item.type) {
    case "user_message":
      return (
        <div className="conversation-row conversation-row-user" key={item.id}>
          <div className="conversation-bubble conversation-user">
            <MarkdownView content={item.text} />
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="conversation-row conversation-row-agent" key={item.id}>
          <div className="conversation-bubble conversation-agent">
            <MarkdownView content={item.text} />
          </div>
        </div>
      );
    case "reasoning":
      return (
        <div className="conversation-row conversation-row-agent" key={item.id}>
          <ReasoningBlock text={item.text} live={isLast && busy} />
        </div>
      );
    case "system_message":
      return <div className="conversation-system" key={item.id}>{item.text}</div>;
    case "trace":
      return (
        <div className="conversation-row conversation-row-agent" key={item.id}>
          <div className="conversation-trace">● {item.message}</div>
        </div>
      );
    case "error":
      return <div className="conversation-error" key={item.id}>{item.code}: {item.message}</div>;
    case "surface":
      return (
        <div className="conversation-row conversation-row-agent" key={item.id}>
          <SurfaceBubble surfaceId={item.surfaceId} />
        </div>
      );
  }
}

/**
 * Wrap runs of consecutive tool groups in a `.toolstep-group` so parallel /
 * sequential tools read as one connected run (Coze-style stacked steps with a
 * left connecting line).
 */
function renderGroups(groups: RenderGroup[], busy: boolean) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < groups.length) {
    const g = groups[i];
    if (g.kind === "tool") {
      const run: Extract<RenderGroup, { kind: "tool" }>[] = [];
      while (i < groups.length && groups[i].kind === "tool") {
        run.push(groups[i] as Extract<RenderGroup, { kind: "tool" }>);
        i++;
      }
      // The last group in the run is "live" only if it's the last overall and busy.
      out.push(
        <div className="toolstep-group" key={`toolgroup-${out.length}`}>
          {run.map((rg, idx) => (
            <GroupRow
              key={(rg.call ?? rg.result)!.id}
              group={rg}
              isLast={i >= groups.length && idx === run.length - 1}
              busy={busy}
            />
          ))}
        </div>
      );
    } else {
      out.push(
        <GroupRow
          key={(g.item as ConversationItem).id}
          group={g}
          isLast={i === groups.length - 1}
          busy={busy}
        />
      );
      i++;
    }
  }
  return out;
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

  const groups = buildGroups(conversation);
  const lastGroup = groups[groups.length - 1];
  const lastIsRunningTool =
    busy && lastGroup?.kind === "tool" && !lastGroup.result;

  return (
    <div className="conversation-list">
      {renderGroups(groups, busy)}
      {busy && !lastIsRunningTool && (
        <div className="conversation-working">
          <span className="conversation-working-dot" />
          <span className="conversation-working-dot" />
          <span className="conversation-working-dot" />
        </div>
      )}
    </div>
  );
}
