/**
 * SSE framing helpers. We hijack the Fastify reply and write raw text/event-stream
 * frames ourselves so we can stream AgentEvents as they arrive from the agent.
 */

import type { FastifyReply } from "fastify";

export function startSSE(reply: FastifyReply) {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  // Tell Fastify we are handling the response ourselves.
  reply.hijack();
  reply.raw.write(": connected\n\n");
}

export function sendEvent(reply: FastifyReply, event: string, data: unknown) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${payload}\n\n`);
}

export function endSSE(reply: FastifyReply) {
  try {
    reply.raw.end();
  } catch {
    /* socket already closed */
  }
}
