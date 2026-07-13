/**
 * Fastify app: CORS + /health + POST /api/chat + POST /api/action.
 *
 * Both /api/chat and /api/action stream AgentEvents over SSE. Every event is
 * routed through `withA2UIAdapter`, so `text` events are scanned for fenced
 * ```a2ui``` blocks and any envelopes found are yielded as `event: a2ui`
 * frames. Outside the fences is still plain text — the default channel.
 *
 * /api/chat   body: { sessionId, message }
 * /api/action body: { sessionId, action: ActionPayload }
 */

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import type { ActionPayload } from "@a2ui/protocol";
import { runAgent } from "../agent/runner.js";
import type { AgentEvent } from "../agent/runner.js";
import { appendMessage } from "../session/store.js";
import { endSSE, sendEvent, startSSE } from "./sse.js";
import { withA2UIAdapter } from "./adapter/a2ui.js";
import { A2UI_INSTRUCTIONS } from "./adapter/prompt.js";
import { buildSelectionPrefix, getRegistry } from "../agent/registry.js";
import { registerFileRoutes } from "./files.js";
import { withImageCapture } from "./image-capture.js";
import { registerHistoryRoutes } from "./history-routes.js";
import { withHistoryTranscript } from "./transcript-tap.js";
import { getOrCreateSession } from "../session/store.js";
import { getAcpPeer } from "../opencode/acp-peer-manager.js";

/** Client-supplied selection of skills / mcp servers / subagents. */
interface Selection {
  agents?: string[];
  skills?: string[];
  mcps?: string[];
}

/**
 * One image attachment. URL MUST be a `/api/files/...` path produced by our
 * own MinIO upload — we reject anything else (data:, http(s)://) to keep the
 * model from being fed arbitrary external payloads. mimeType is optional;
 * opencode/ACP figures it out from the URL when missing.
 */
interface ChatAttachment {
  url: string;
  mimeType?: string;
}

interface ChatBody {
  sessionId?: string;
  message?: string;
  selection?: Selection;
  /** Resume a specific opencode/ACP session (set by the client on history load). */
  opencodeSessionId?: string;
  /** Image attachments fed to the model as ACP image parts (separate from text). */
  attachments?: ChatAttachment[];
}

interface ActionBody {
  sessionId?: string;
  action?: ActionPayload;
  selection?: Selection;
  opencodeSessionId?: string;
}

/** Serialize an ActionPayload into a single text message for opencode. */
function actionToMessage(a: ActionPayload): string {
  const payload = JSON.stringify(
    {
      context: a.context ?? {},
      a2uiClientDataModel: a.a2uiClientDataModel ?? null,
    },
    null,
    2
  );
  return (
    `[A2UI ACTION] surface=${a.surfaceId} name=${a.name} ` +
    `source=${a.sourceComponentId ?? "?"} at=${a.timestamp}\n` +
    `payload: ${payload}\n` +
    "Respond via the same A2UI instructions (text outside ```a2ui fences, " +
    "envelopes inside, only when structured UI is warranted)."
  );
}

async function* streamWithAdapter(
  events: AsyncIterable<AgentEvent>
): AsyncIterable<AgentEvent> {
  let cur = events;
  for await (const ev of withA2UIAdapter(cur)) yield ev;
}

/** Wrap the adapter output with MinIO image capture (tool_result + a2ui). */
async function* streamWithImageCapture(
  events: AsyncIterable<AgentEvent>
): AsyncIterable<AgentEvent> {
  for await (const ev of withImageCapture(events)) yield ev;
}

/** Drain an AgentEvent stream into SSE frames. Closes on done or error. */
async function pipeSse(
  reply: FastifyReply,
  stream: AsyncIterable<AgentEvent>
): Promise<void> {
  try {
    for await (const ev of stream) sendEvent(reply, ev.type, ev);
  } catch (err) {
    sendEvent(reply, "error", {
      code: "AGENT_ERROR",
      message: (err as Error).message,
    });
  } finally {
    endSSE(reply);
  }
}

export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: "info" } });

  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  /** Expose the static skill/mcp/subagent registry to the frontend picker. */
  app.get("/api/agents", async () => getRegistry());

  /** Image storage: GET /api/files/* (proxy) + POST /api/images/upload. */
  await registerFileRoutes(app);

  /** Conversation history: list / get / rename / delete. */
  await registerHistoryRoutes(app);

  app.post<{ Body: ChatBody }>("/api/chat", async (req, reply) => {
    const { sessionId, message, selection, opencodeSessionId, attachments } =
      req.body ?? {};
    if (!sessionId || typeof message !== "string") {
      reply.code(400);
      return { error: "sessionId and message required" };
    }

    // Attachment validation: must be /api/files/... (own bucket only). Reject
    // data: and arbitrary http(s) to prevent the client from injecting
    // arbitrary content for the model to fetch.
    const safeAttachments: ChatAttachment[] = [];
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (!a || typeof a.url !== "string") continue;
        if (!a.url.startsWith("/api/files/")) continue;
        if (a.url.includes("..")) continue; // path traversal
        safeAttachments.push({
          url: a.url,
          ...(typeof a.mimeType === "string" ? { mimeType: a.mimeType } : {}),
        });
      }
    }

    const prefix = buildSelectionPrefix(selection);
    const finalMessage = prefix ? `${prefix}\n\n${message}` : message;

    app.log.info(
      { sessionId, selection, attachmentCount: safeAttachments.length },
      "chat turn"
    );
    appendMessage(sessionId, { role: "user", content: finalMessage, ts: Date.now() });

    startSSE(reply);
    await pipeSse(
      reply,
      withHistoryTranscript(
        streamWithImageCapture(
          streamWithAdapter(
            runAgent(
              {
                sessionId,
                message: finalMessage,
                opencodeSessionId,
                ...(safeAttachments.length ? { attachments: safeAttachments } : {}),
              },
              { firstMessagePrefix: A2UI_INSTRUCTIONS }
            )
          )
        ),
        sessionId,
        message // raw (unprefixed) message for title/preview + transcript
      )
    );
  });

  app.post<{ Body: ActionBody }>("/api/action", async (req, reply) => {
    const { sessionId, action, selection, opencodeSessionId } = req.body ?? {};
    if (!sessionId || !action?.name) {
      reply.code(400);
      return { error: "sessionId and action required" };
    }

    app.log.info(
      { sessionId, action: action.name, surface: action.surfaceId },
      "action turn"
    );
    const serialized = actionToMessage(action);
    const prefix = buildSelectionPrefix(selection);
    const finalMessage = prefix ? `${prefix}\n\n${serialized}` : serialized;

    appendMessage(sessionId, {
      role: "user",
      content: finalMessage,
      ts: Date.now(),
    });

    startSSE(reply);
    await pipeSse(
      reply,
      withHistoryTranscript(
        streamWithImageCapture(
          streamWithAdapter(
            runAgent({ sessionId, message: finalMessage, opencodeSessionId })
            // no firstMessagePrefix: the prefix is already in the session from the
            // first /api/chat call, and re-injecting would pollute context.
          )
        ),
        sessionId,
        serialized
      )
    );
  });

  /** Abort the in-flight turn for a session (Stop button). Best-effort. */
  app.post<{ Body: { sessionId?: string } }>("/api/cancel", async (req, reply) => {
    const { sessionId } = req.body ?? {};
    if (!sessionId) {
      reply.code(400);
      return { error: "sessionId required" };
    }
    const peer = getAcpPeer();
    if (!peer) {
      reply.code(503);
      return { error: "agent peer unavailable" };
    }
    const ocId = getOrCreateSession(sessionId).opencodeSessionId;
    if (!ocId) {
      // No opencode session yet (nothing in flight) - report success anyway.
      return { ok: true, running: false };
    }
    try {
      await peer.client.sessionCancel(ocId);
    } catch {
      // Cancel is best-effort: the prompt may already have finished.
    }
    return { ok: true, running: false };
  });

  return app;
}
