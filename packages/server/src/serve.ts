/**
 * HTTP entry point. Boots the Fastify SSE gateway on top of the opencode agent
 * runtime. Sibling to src/index.ts (the CLI driver) — both are thin drivers
 * over runAgent().
 */

import { createApp } from "./http/app.js";
import { ENV } from "./env.js";

async function main() {
  const app = await createApp();

  try {
    await app.listen({ port: ENV.PORT, host: ENV.HOST });
    app.log.info(
      `A2UI agent server listening on http://localhost:${ENV.PORT} (bin=${ENV.OPENCODE_BIN})`
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
