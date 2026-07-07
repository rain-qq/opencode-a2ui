/**
 * ACP event mapping. Translates opencode's `session/update` notification
 * payloads (the `update` field) into the public AgentEvent union — the SAME
 * surface the old `opencode run` NDJSON path produced, so everything
 * downstream (the A2UI fence adapter, the SSE layer, the client) is unchanged.
 *
 * opencode's ACP `sessionUpdate` discriminants (verified v1.17.13):
 *   agent_message_chunk        content:{type:"text"|"reasoning", text}
 *   tool_call                  toolCallId, kind/title, status:"pending", rawInput:{}
 *   tool_call_update           status:"in_progress"|"completed"|"error", rawInput/rawOutput
 *   available_commands_update  availableCommands[] (ignored in plan A)
 *
 * The mapper is STATEFUL per turn: the bare `tool_call` (pending) event carries
 * an EMPTY rawInput — the real args only arrive on the subsequent
 * `tool_call_update` (in_progress). So we defer emitting `tool_call` until we
 * have args (in_progress), falling back to emitting it on completed/error if
 * in_progress was skipped. Tool names are captured at the pending event and
 * reused for the result (the completed update's title mutates to e.g. the file
 * path, not the tool kind).
 *
 * Notable win over the old NDJSON path: reasoning is an explicit content type
 * — no more stripThinking heuristic (kept as a defensive no-op for providers
 * that might still leak CoT into text).
 */

import type { AgentEvent } from "../agent/runner.js";
import type { AcpUpdate } from "./acp-client.js";

/**
 * Reasoning block delimiters, each an [open, close] pair. Some providers
 * (MiniMax/Qwen) embed chain-of-thought in the text channel; ACP is supposed
 * to surface it as a `reasoning` content type, but we strip it defensively in
 * case a provider still leaks CoT into text.
 *
 * The ``` ```think``` ``` pair is built via String.fromCharCode(96) so the
 * backticks survive in source (markdown/linters would otherwise eat them).
 */
const THINKING_TAGS: ReadonlyArray<readonly [string, string]> = (() => {
  const b = String.fromCharCode(96); // "`"
  return [
    [b + b + b + "think" + b, "think" + b + b + b],
    ["<thinking>", "</thinking>"],
    ["【思考】", "【/思考】"],
  ];
})();

/** Strip thinking-block content (open + body + close, all removed). */
function stripThinking(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [open, close] of THINKING_TAGS) {
    let safety = 64;
    while (safety-- > 0) {
      const start = out.indexOf(open);
      if (start < 0) break;
      const end = out.indexOf(close, start + open.length);
      if (end < 0) break;
      out = out.slice(0, start) + out.slice(end + close.length);
    }
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toolName(update: AcpUpdate): string {
  return asString(update.kind) ?? asString(update.title) ?? "tool";
}

/**
 * Stateful per-turn mapper. Construct one per runAgent call (toolCallIds are
 * scoped to a turn; a fresh mapper avoids unbounded growth and cross-turn
 * contamination).
 */
export class AcpUpdateMapper {
  /** toolCallId → tool name captured at the pending event. */
  private names = new Map<string, string>();
  /** toolCallIds whose tool_call has already been emitted. */
  private emitted = new Set<string>();

  /** Map one ACP `session/update` payload to zero or more AgentEvents. */
  map(update: AcpUpdate): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as
          | { type?: string; text?: string }
          | undefined;
        if (!content) break;
        if (content.type === "text") {
          const text = stripThinking(content.text ?? "");
          if (text.trim()) out.push({ type: "text", text });
        } else if (content.type === "reasoning") {
          const text = content.text ?? "";
          if (text.trim()) out.push({ type: "reasoning", text });
        }
        // Unknown content types (image, etc.) are dropped — not surfaced yet.
        break;
      }

      case "tool_call": {
        const id = asString(update.toolCallId);
        if (!id) break;
        // Capture the name; defer emitting until args arrive (in_progress).
        this.names.set(id, toolName(update));
        break;
      }

      case "tool_call_update": {
        const id = asString(update.toolCallId);
        if (!id) break;
        const name = this.names.get(id) ?? toolName(update);
        const status = asString(update.status);

        if (status === "in_progress") {
          // Args are now present — emit the tool_call (once).
          if (!this.emitted.has(id)) {
            this.emitted.add(id);
            out.push({
              type: "tool_call",
              id,
              name,
              args: update.rawInput,
            });
          }
        } else if (status === "completed") {
          if (!this.emitted.has(id)) {
            // in_progress was skipped — emit a late tool_call (args unknown).
            this.emitted.add(id);
            out.push({ type: "tool_call", id, name });
          }
          out.push({
            type: "tool_result",
            id,
            name,
            result: update.rawOutput ?? update.content ?? null,
          });
        } else if (status === "error") {
          if (!this.emitted.has(id)) {
            this.emitted.add(id);
            out.push({ type: "tool_call", id, name });
          }
          const err =
            asString(update.error) ??
            asString(
              (update.rawOutput as { error?: string } | undefined)?.error
            ) ??
            "tool error";
          out.push({ type: "tool_result", id, name, error: err });
        }
        break;
      }

      case "available_commands_update":
        // Skill/command catalog. Not surfaced in plan A — the picker still
        // uses the static registry + prompt-prefix selection.
        break;

      default:
        // Unknown discriminant — pass through silently. Surfacing unknown wire
        // events would pollute the conversation; dropping keeps the stream clean.
        break;
    }
    return out;
  }
}
