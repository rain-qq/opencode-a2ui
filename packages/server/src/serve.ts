/**
 * HTTP entry point. Boots the Fastify SSE gateway on top of the opencode agent
 * runtime. Sibling to src/index.ts (the CLI driver) — both are thin drivers
 * over runAgent().
 *
 * Before listening, boots ONE long-lived `opencode acp` ACP peer and registers
 * it as the runAgent default (initialize handshake). If that bootstrap fails we
 * still listen (so /health and /api/agents work), but each /api/chat turn fails
 * with a clear "No ACP client" error — ACP is the only transport, there is no
 * per-request spawn fallback.
 */

import { createApp } from "./http/app.js";
import { ENV } from "./env.js";
import { startAcpPeer, stopAcpPeer } from "./opencode/acp-peer-manager.js";

async function main() {
  const peer = await startAcpPeer();

  try {
    const app = await createApp();
    await app.listen({ port: ENV.PORT, host: ENV.HOST });
    app.log.info(
      `A2UI agent server listening on http://localhost:${ENV.PORT} (bin=${ENV.OPENCODE_BIN})`
    );
    if (peer) app.log.info(`opencode ACP peer attached`);
    else app.log.warn(`opencode ACP peer NOT started — chat turns will error`);

    // Tear down the peer (whole process tree) on exit so it can't go ghost.
    const cleanup = () => {
      stopAcpPeer(peer);
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (err) {
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    stopAcpPeer(peer);
    process.exit(1);
  }
}

main();
