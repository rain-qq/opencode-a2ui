/**
 * Conversation history HTTP routes:
 *   GET    /api/history        list all entries (newest first)
 *   GET    /api/history/:id    one entry + its full transcript (for replay)
 *   PATCH  /api/history/:id    rename (body { title })
 *   DELETE /api/history/:id    remove entry + transcript file
 */

import type { FastifyInstance } from "fastify";
import {
  deleteHistory,
  getHistory,
  listHistory,
  patchHistory,
  readTranscript,
} from "../session/history-store.js";

interface RenameBody {
  title?: string;
}

export async function registerHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/history", async () => listHistory());

  app.get<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const { id } = req.params;
    const entry = getHistory(id);
    if (!entry) {
      reply.code(404);
      return { error: "not found" };
    }
    return { entry, transcript: readTranscript(id) };
  });

  app.patch<{ Body: RenameBody; Params: { id: string } }>(
    "/api/history/:id",
    async (req, reply) => {
      const { id } = req.params;
      const { title } = req.body ?? {};
      if (typeof title !== "string" || title.length === 0) {
        reply.code(400);
        return { error: "title required" };
      }
      const entry = patchHistory(id, { title });
      if (!entry) {
        reply.code(404);
        return { error: "not found" };
      }
      return { entry };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const { id } = req.params;
    const ok = deleteHistory(id);
    if (!ok) {
      reply.code(404);
      return { error: "not found" };
    }
    return { ok: true };
  });
}
