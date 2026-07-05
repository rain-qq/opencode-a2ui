/**
 * Agent runtime. The public "底座" API: take a session + message, return a
 * stream of normalized AgentEvent. Multi-turn continuity comes from passing
 * the opencode session id (--session) captured on the first run.
 *
 * This layer owns NO output-format policy (no A2UI, no prompt injection). It
 * faithfully surfaces opencode's own step / tool / text / reasoning events.
 */

import type { A2UIEnvelope } from "@a2ui/protocol";
import { OpencodeClient } from "../opencode/client.js";
import type { OpencodeStreamItem } from "../opencode/client.js";
import type { OpencodeEvent } from "../opencode/events.js";
import { stripThinking } from "../opencode/events.js";
import { getOrCreateSession, setOpencodeSessionId } from "../session/store.js";

export type AgentEvent =
  | { type: "session"; opencodeSessionId: string }
  | { type: "step_start" }
  | { type: "step_finish"; reason?: string }
  | { type: "tool_call"; id: string; name: string; args?: unknown }
  | { type: "tool_result"; id: string; name: string; result?: unknown; error?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "trace"; message: string }
  | { type: "a2ui"; envelopes: A2UIEnvelope[] }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export interface RunAgentInput {
  sessionId: string;
  message: string;
  /** Explicitly continue this opencode session (overrides any stored id). */
  opencodeSessionId?: string;
  /** Continue opencode's last session (--continue). */
  continueLast?: boolean;
}

export interface RunAgentOptions {
  /** Inject a client (testing). Defaults to a shared singleton. */
  client?: OpencodeClient;
  /**
   * Optional system-prompt-style instructions prepended only to the first
   * message of a fresh opencode session. Subsequent turns use opencode's own
   * session history, so the override is not re-injected.
   */
  firstMessagePrefix?: string;
}

let defaultClient: OpencodeClient | undefined;
function getDefaultClient(): OpencodeClient {
  if (!defaultClient) defaultClient = new OpencodeClient();
  return defaultClient;
}

function recoverableCallId(id: unknown): string {
  return typeof id === "string" && id.length > 0
    ? id
    : `oc_${Math.random().toString(36).slice(2, 10)}`;
}

/** Map a parsed opencode event to zero or more AgentEvents. */
function mapOpencodeEvent(event: OpencodeEvent): AgentEvent[] {
  const out: AgentEvent[] = [];
  const part = event.part ?? {};
  switch (event.type) {
    case "step_start":
      out.push({ type: "step_start" });
      break;

    case "step_finish":
      out.push({ type: "step_finish", reason: part.reason });
      break;

    case "tool_use": {
      const id = recoverableCallId(part.callID);
      const name = typeof part.tool === "string" ? part.tool : "tool";
      const args = part.state?.input;
      out.push({ type: "tool_call", id, name, args });
      const status = part.state?.status;
      if (status === "completed") {
        out.push({ type: "tool_result", id, name, result: part.state?.output ?? null });
      } else if (status === "error") {
        out.push({ type: "tool_result", id, name, error: part.state?.error ?? "tool error" });
      }
      break;
    }

    case "text": {
      // Strip provider-specific reasoning blocks ("`` /\ `` etc.).
      // Some providers (MiniMax) embed chain-of-thought in the same channel
      // as the final answer; without stripping, draft fences inside the
      // thinking block would confuse the A2UI adapter downstream.
      const text = stripThinking(part.text ?? "");
      if (text.trim()) out.push({ type: "text", text });
      break;
    }

    case "reasoning": {
      const text = part.reason ?? part.text ?? "";
      if (text.trim()) out.push({ type: "reasoning", text });
      break;
    }

    case "error":
      out.push({
        type: "error",
        code: "OPENCODE_ERROR",
        message:
          typeof part.state?.error === "string"
            ? part.state.error
            : "opencode error",
      });
      break;

    default:
      break;
  }
  return out;
}

function mapStreamItem(item: OpencodeStreamItem): AgentEvent[] {
  switch (item.kind) {
    case "event":
      return mapOpencodeEvent(item.event);
    case "stderr": {
      // opencode's own runtime logs (--print-logs). Internal debug noise —
      // don't surface as a client trace. Echo to the server stderr so it's
      // still available when debugging locally.
      const line = item.line.trim();
      if (line) process.stderr.write(`[opencode] ${line}\n`);
      return [];
    }
    case "heartbeat":
      // No-output heartbeat. The client already shows a "…streaming" busy
      // indicator while a turn is in flight, so this trace is pure noise.
      return [];
    case "exit": {
      if (item.spawnError) {
        const e = item.spawnError as NodeJS.ErrnoException;
        const hint =
          e.code === "ENOENT"
            ? `找不到可执行文件。请把 OPENCODE_BIN 设为 opencode 真实可执行文件的绝对路径(Windows 上通常是 ...\\node_modules\\opencode-ai\\bin\\opencode.exe,不要用 .cmd/.ps1 shim)。`
            : e.message;
        return [{ type: "error", code: "OPENCODE_SPAWN_FAILED", message: hint }];
      }
      if (item.code === 0) return [];
      return [
        {
          type: "error",
          code: "OPENCODE_EXIT",
          message:
            item.code === null
              ? "opencode exited with null code (killed by signal?)"
              : `opencode exited with code ${item.code}`,
        },
      ];
    }
  }
}

export async function* runAgent(
  input: RunAgentInput,
  opts: RunAgentOptions = {}
): AsyncIterable<AgentEvent> {
  const client = opts.client ?? getDefaultClient();
  const session = getOrCreateSession(input.sessionId);

  // Surface the bin path on the server stderr (debugging) without pushing a
  // client trace that clutters the conversation.
  process.stderr.write(`[agent] opencode bin=${client.config.bin}\n`);

  let sessionEmitted = false;
  // Inject the prefix only on the very first turn of a new opencode session.
  // opencode carries the conversation forward on subsequent --session runs, so
  // re-injecting would spam the context window.
  const isFirstTurn = !session.opencodeSessionId && !input.opencodeSessionId;
  const message = isFirstTurn && opts.firstMessagePrefix
    ? `${opts.firstMessagePrefix}\n\nUser message:\n${input.message}`
    : input.message;

  const stream = client.run({
    session: input.opencodeSessionId ?? session.opencodeSessionId,
    continueLast: input.continueLast,
    message,
  });

  try {
    for await (const item of stream) {
      // Capture + surface the opencode session id on first sight.
      if (item.kind === "event" && item.event.sessionID && !sessionEmitted) {
        const ocId = item.event.sessionID;
        setOpencodeSessionId(input.sessionId, ocId);
        sessionEmitted = true;
        yield { type: "session", opencodeSessionId: ocId };
      }
      for (const ev of mapStreamItem(item)) yield ev;
    }
  } catch (err) {
    yield {
      type: "error",
      code: "AGENT_ERROR",
      message: (err as Error).message,
    };
  }

  yield { type: "done" };
}
