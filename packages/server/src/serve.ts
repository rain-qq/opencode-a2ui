/**
 * HTTP entry point. Boots the Fastify SSE gateway on top of the opencode agent
 * runtime. Sibling to src/index.ts (the CLI driver) — both are thin drivers
 * over runAgent().
 *
 * Before listening, optionally boots a long-lived `opencode serve` so every
 * `opencode run` attaches to it (--attach) instead of cold-starting. If that
 * bootstrap fails we proceed anyway — per-request spawn is the silent fallback.
 */

import { createApp } from "./http/app.js";
import { ENV } from "./env.js";
import {
  startOpencodeServer,
  stopOpencodeServer,
} from "./opencode/serve-manager.js";

async function main() {
  const server = await startOpencodeServer();

  try {
    const app = await createApp();
    await app.listen({ port: ENV.PORT, host: ENV.HOST });
    app.log.info(
      `A2UI agent server listening on http://localhost:${ENV.PORT} (bin=${ENV.OPENCODE_BIN})`
    );
    if (server) app.log.info(`opencode serve attached at ${server.url}`);
    else app.log.info(`opencode serve not started — per-request spawn fallback`);

    // Tear down the serve child (whole tree) on exit so it can't go ghost.
    const cleanup = () => {
      stopOpencodeServer(server);
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (err) {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    stopOpencodeServer(server);
    process.exit(1);
  }
}

main();
