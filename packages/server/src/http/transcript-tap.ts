/**
 * History transcript tap. A transparent stream transform that observes the
 * (already A2UI-adapted, already image-captured) AgentEvent stream and records
 * a compact transcript to disk so a past conversation can be replayed on
 * resume - without otherwise changing the events the client receives.
 *
 * Delta merging mirrors the client store: streamed text/reasoning deltas are
 * accumulated into ONE item per contiguous span, closed when a non-text event
 * arrives (tool_call / a2ui / trace / error) or at turn end. tool_call and
 * tool_result are stored as-is (their images are already /api/files URLs by
 * this point, since image-capture ran first).
 *
 * Surfaces are stored as lightweight archived markers - the full component
 * graph is NOT replayed (MVP); opencode keeps the real model context.
 */

import type { AgentEvent } from "../agent/runner.js";
import {
  appendTranscriptItem,
  getHistory,
  upsertHistory,
  type HistoryTranscriptItem,
} from "../session/history-store.js";

function titleFrom(msg: string): string {
  const oneLine = msg.replace(/\s+/g, " ").trim();
  return oneLine.slice(0, 30) || "新对话";
}
function previewFrom(msg: string): string {
  return msg.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function withHistoryTranscript(
  events: AsyncIterable<AgentEvent>,
  sessionId: string,
  userMessage: string
): AsyncIterable<AgentEvent> {
  let pendingText: string | null = null;
  let pendingReasoning: string | null = null;
  let userAppended = false;

  const flushText = async () => {
    if (pendingText !== null) {
      appendTranscriptItem(sessionId, {
        type: "assistant_text",
        ts: Date.now(),
        text: pendingText,
      });
      pendingText = null;
    }
  };
  const flushReasoning = async () => {
    if (pendingReasoning !== null) {
      appendTranscriptItem(sessionId, {
        type: "reasoning",
        ts: Date.now(),
        text: pendingReasoning,
      });
      pendingReasoning = null;
    }
  };
  const flushBoth = async () => {
    await flushText();
    await flushReasoning();
  };

  return (async function* (): AsyncIterable<AgentEvent> {
    for await (const ev of events) {
      switch (ev.type) {
        case "session": {
          // First turn establishes the title/preview; later turns keep them.
          const existing = getHistory(sessionId);
          upsertHistory(
            sessionId,
            ev.opencodeSessionId,
            existing
              ? undefined
              : { title: titleFrom(userMessage), preview: previewFrom(userMessage) }
          );
          if (!userAppended) {
            appendTranscriptItem(sessionId, {
              type: "user_message",
              ts: Date.now(),
              text: userMessage,
            });
            userAppended = true;
          }
          break;
        }
        case "text":
          await flushReasoning();
          if (pendingText === null) pendingText = "";
          pendingText += ev.text;
          break;
        case "reasoning":
          await flushText();
          if (pendingReasoning === null) pendingReasoning = "";
          pendingReasoning += ev.text;
          break;
        case "tool_call":
          await flushBoth();
          appendTranscriptItem(sessionId, {
            type: "tool_call",
            ts: Date.now(),
            callId: ev.id,
            name: ev.name,
            args: ev.args,
          });
          break;
        case "tool_result":
          await flushBoth();
          appendTranscriptItem(sessionId, {
            type: "tool_result",
            ts: Date.now(),
            callId: ev.id,
            name: ev.name,
            result: ev.result,
            error: ev.error,
          });
          break;
        case "trace":
          await flushBoth();
          appendTranscriptItem(sessionId, {
            type: "trace",
            ts: Date.now(),
            message: ev.message,
          });
          break;
        case "a2ui":
          await flushBoth();
          for (const env of ev.envelopes) {
            if (env.createSurface) {
              appendTranscriptItem(sessionId, {
                type: "surface",
                ts: Date.now(),
                surfaceId: env.createSurface.surfaceId,
                archived: true,
              });
            }
          }
          break;
        case "error":
          await flushBoth();
          appendTranscriptItem(sessionId, {
            type: "error",
            ts: Date.now(),
            code: ev.code,
            message: ev.message,
          });
          break;
        default:
          // step_start / step_finish / done - not part of the replayed timeline.
          break;
      }
      yield ev;
    }
    await flushBoth();
    // Bump updatedAt to turn-end so the sidebar sorts by last activity.
    upsertHistory(sessionId, "", undefined);
  })();
}
