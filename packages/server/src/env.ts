import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
export const workspaceRoot = resolve(packageDir, "..", "..");

/**
 * Load env files explicitly instead of relying on dotenv/config's cwd.
 *
 * Precedence after loading (later wins via override):
 *   1. workspace root .env
 *   2. packages/server/.env
 *
 * .env.example is intentionally not loaded; it should be a template only.
 */
for (const path of [
  resolve(workspaceRoot, ".env"),
  resolve(packageDir, ".env"),
]) {
  if (existsSync(path)) {
    dotenv.config({ path, override: true });
  }
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export const ENV = {
  /** HTTP server port (SSE gateway). */
  PORT: Number(process.env.PORT ?? 3001),
  /** HTTP server bind host. */
  HOST: process.env.HOST ?? "0.0.0.0",
  /**
   * Path to the opencode executable. On Windows, point this at the real
   * `opencode.exe` (NOT a `.cmd`/`.ps1` shim) so Node can pass argv verbatim
   * without a shell in the middle.
   */
  OPENCODE_BIN: process.env.OPENCODE_BIN ?? "opencode",
  /** Working directory passed to `opencode acp` via --cwd (and to session/new). */
  OPENCODE_WORKDIR: process.env.OPENCODE_WORKDIR ?? workspaceRoot,
  /** Run without external plugins (opencode --pure). Predictable baseline. */
  OPENCODE_PURE: bool("OPENCODE_PURE", true),
  /** Forward opencode logs to stderr (opencode --print-logs). Debug only. */
  OPENCODE_PRINT_LOGS: bool("OPENCODE_PRINT_LOGS", true),
  /**
   * Max ms to wait for the `opencode acp` peer's `initialize` handshake.
   * Includes opencode's bootstrap (config load, provider warm-up) — ~2-3s in
   * practice, so 15s is a generous ceiling. On timeout the peer is disposed
   * and startAcpPeer returns null (server still listens; chat errors clearly).
   */
  OPENCODE_ACP_STARTUP_TIMEOUT_MS: Number(
    process.env.OPENCODE_ACP_STARTUP_TIMEOUT_MS ?? 15000
  ),
};

if (!ENV.OPENCODE_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[server] OPENCODE_BIN is empty. Set it to the opencode executable path."
  );
}
