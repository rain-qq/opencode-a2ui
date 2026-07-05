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

/** Client-supplied selection of skills / mcp servers / subagents. */
interface Selection {
  agents?: string[];
  skills?: string[];
  mcps?: string[];
}

interface ChatBody {
  sessionId?: string;
  message?: string;
  selection?: Selection;
}

interface ActionBody {
  sessionId?: string;
  action?: ActionPayload;
  selection?: Selection;
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
  for await (const ev of withA2UIAdapter(events)) yield ev;
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

  app.post<{ Body: ChatBody }>("/api/chat", async (req, reply) => {
    const { sessionId, message, selection } = req.body ?? {};
    if (!sessionId || typeof message !== "string") {
      reply.code(400);
      return { error: "sessionId and message required" };
    }

    const prefix = buildSelectionPrefix(selection);
    const finalMessage = prefix ? `${prefix}\n\n${message}` : message;

    app.log.info({ sessionId, selection }, "chat turn");
    appendMessage(sessionId, { role: "user", content: finalMessage, ts: Date.now() });

    startSSE(reply);
    await pipeSse(
      reply,
      streamWithAdapter(
        runAgent(
          { sessionId, message: finalMessage },
          { firstMessagePrefix: A2UI_INSTRUCTIONS }
        )
      )
    );
  });

  app.post<{ Body: ActionBody }>("/api/action", async (req, reply) => {
    const { sessionId, action, selection } = req.body ?? {};
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
      streamWithAdapter(
        runAgent({ sessionId, message: finalMessage })
        // no firstMessagePrefix: the prefix is already in the session from the
        // first /api/chat call, and re-injecting would pollute context.
      )
    );
  });

  return app;
}
