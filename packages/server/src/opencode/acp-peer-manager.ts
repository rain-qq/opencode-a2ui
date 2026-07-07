/**
 * Long-lived `opencode acp` peer lifecycle manager.
 *
 * Spawns ONE headless opencode ACP peer at bootstrap, performs the JSON-RPC
 * `initialize` handshake, and registers it as the runAgent default client via
 * setDefaultAcpClient. Every subsequent turn reuses this single peer (no
 * per-request cold start, no per-request spawn) — multi-turn continuity is
 * native via session/load.
 *
 * If the peer fails to boot (spawn error, initialize timeout, early exit),
 * startAcpPeer resolves null and no default client is registered: the HTTP
 * server still comes up (so /health and /api/agents work), but each /api/chat
 * turn fails with a clear "No ACP client" error from runAgent. Unlike the old
 * `opencode serve` optimization, ACP is the only transport — there is no
 * per-request spawn fallback.
 *
 * Process-tree cleanup is mandatory on Windows (see process-tree.ts): a crashed
 * parent leaves ghost opencode.exe children holding resources.
 */

import { ENV } from "../env.js";
import { AcpClient } from "./acp-client.js";
import { setDefaultAcpClient } from "../agent/runner.js";

export interface AcpPeerHandle {
  client: AcpClient;
}

/**
 * Spawn `opencode acp` and perform the initialize handshake. Resolves null on
 * spawn error / init timeout / early exit — caller then serves without a peer
 * (chat turns error clearly). On success the peer is registered as the
 * runAgent default.
 */
export async function startAcpPeer(): Promise<AcpPeerHandle | null> {
  const client = new AcpClient();

  try {
    await withTimeout(client.initialize(), ENV.OPENCODE_ACP_STARTUP_TIMEOUT_MS);
  } catch (err) {
    process.stderr.write(
      `[acp-peer] initialize failed: ${(err as Error).message}\n`
    );
    // Best-effort cleanup of the partial spawn so it can't go ghost.
    client.dispose();
    return null;
  }

  setDefaultAcpClient(client);
  process.stderr.write(
    `[acp-peer] opencode ACP peer ready (bin=${client.config.bin})\n`
  );
  return { client };
}

/** Stop a previously started peer (whole process tree). */
export function stopAcpPeer(handle: AcpPeerHandle | null): void {
  if (!handle) return;
  handle.client.dispose();
}

/** Reject after `ms` if the promise hasn't settled. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ACP initialize timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
