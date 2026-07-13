/**
 * Coze-style unified tool step.
 *
 * A tool invocation is a (tool_call, tool_result) pair keyed by callId. Instead
 * of rendering them as two separate cards (the old behavior), we merge them
 * into ONE compact, collapsible card with a status pill:
 *
 *   running  -> blue spinner + "运行中"
 *   done     -> green check  + "已完成"
 *   error    -> red cross    + "失败"
 *
 * Default collapsed; click to expand args + result. Consecutive ToolSteps are
 * wrapped in a `.toolstep-group` by ConversationView so they read as one run.
 */

import React, { useState } from "react";
import type { ConversationItem } from "../a2ui/store.js";

type ToolCall = Extract<ConversationItem, { type: "tool_call" }>;
type ToolResult = Extract<ConversationItem, { type: "tool_result" }>;

function preview(value: unknown, max = 600): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const TOOL_ICONS: ReadonlyArray<{ re: RegExp; icon: string }> = [
  { re: /image|draw|paint|dalle|generat|图|画/i, icon: "🖼️" },
  { re: /read|grep|glob|search|find|查|搜/i, icon: "📖" },
  { re: /write|edit|patch|create|mkdir|move|touch|写|改/i, icon: "✏️" },
  { re: /bash|exec|sh|cmd|run|terminal|执行|命令/i, icon: "⬛" },
  { re: /web|fetch|http|url|browse|curl|网/i, icon: "🌐" },
  { re: /task|todo|plan|计划|任务/i, icon: "📋" },
];

function iconFor(name: string): string {
  for (const t of TOOL_ICONS) if (t.re.test(name)) return t.icon;
  return "🔧";
}

type Status = "running" | "done" | "error";

interface ToolStepProps {
  call?: ToolCall;
  result?: ToolResult;
}

export function ToolStep({ call, result }: ToolStepProps) {
  const [expanded, setExpanded] = useState(false);
  const name = call?.name ?? result?.name ?? "tool";
  const status: Status = result
    ? result.error !== undefined
      ? "error"
      : "done"
    : "running";

  const hasArgs = !!call && call.args !== undefined && call.args !== null;
  const hasResult =
    !!result && (result.result !== undefined || result.error !== undefined);
  const expandable = hasArgs || hasResult;

  return (
    <div className={`toolstep toolstep-${status}`}>
      <button
        type="button"
        className="toolstep-header"
        onClick={() => expandable && setExpanded((v) => !v)}
        aria-expanded={expandable && expanded}
        disabled={!expandable}
      >
        <span className="toolstep-icon">{iconFor(name)}</span>
        <span className="toolstep-name">{name}</span>
        <span className={`toolstep-status toolstep-status-${status}`}>
          {status === "running" && <span className="toolstep-spinner" aria-hidden />}
          <span className="toolstep-status-text">
            {status === "running" ? "运行中" : status === "done" ? "已完成" : "失败"}
          </span>
        </span>
        {expandable && (
          <span className={`toolstep-chevron${expanded ? " open" : ""}`} aria-hidden>
            ▾
          </span>
        )}
      </button>
      {expanded && expandable && (
        <div className="toolstep-body">
          {hasArgs && (
            <div className="toolstep-section">
              <div className="toolstep-section-label">参数</div>
              <pre className="toolstep-json">{preview(call!.args)}</pre>
            </div>
          )}
          {hasResult && (
            <div className="toolstep-section">
              <div className="toolstep-section-label">
                {status === "error" ? "错误" : "结果"}
              </div>
              <pre className="toolstep-json">
                {status === "error"
                  ? preview(result!.error)
                  : preview(result!.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
