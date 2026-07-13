/**
 * Image storage HTTP routes:
 *   GET  /api/files/*           stream a stored object from MinIO (the URL all
 *                               rewritten image references point at)
 *   POST /api/images/upload     upload a `data:` URI (e.g. from a client file
 *                               input or the Markdown image-capture path),
 *                               returns { url }
 *
 * Both degrade gracefully: if MinIO is unavailable, /api/files returns 503 and
 * /api/images/upload returns 503 - never a hard crash.
 */

import type { FastifyInstance } from "fastify";
import { streamObjectToReply, uploadFromDataUri } from "../storage/minio.js";

interface UploadBody {
  data?: string;
  filename?: string;
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Stream a stored image object back to the browser. The wildcard captures the
   * full key (`a2ui/<date>/<hash>.<ext>`); decode it (browsers may URL-encode).
   */
  app.get<{ Params: { "*": string } }>("/api/files/*", async (req, reply) => {
    const key = decodeURIComponent(String(req.params["*"] ?? ""));
    if (!key || key.includes("..")) {
      reply.code(400);
      return { error: "invalid key" };
    }
    return streamObjectToReply(reply, key);
  });

  /**
   * Upload a data: URI and return its `/api/files/...` url. The client uses
   * this for user-attached files and for markdown-inline images it captured.
   * 50 MB body limit to allow large pasted screenshots.
   */
  app.post<{ Body: UploadBody }>(
    "/api/images/upload",
    { bodyLimit: 50 * 1024 * 1024 },
    async (req, reply) => {
      const { data } = req.body ?? {};
      if (typeof data !== "string" || data.length === 0) {
        reply.code(400);
        return { ok: false, error: "data (data: URI string) required" };
      }
      const url = await uploadFromDataUri(data);
      if (!url) {
        reply.code(503);
        return { ok: false, error: "image storage unavailable" };
      }
      return { ok: true, url };
    }
  );
}
