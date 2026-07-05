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
  /** Working directory passed to opencode via --dir. */
  OPENCODE_WORKDIR: process.env.OPENCODE_WORKDIR ?? workspaceRoot,
  /** Optional model override, passed as `-m provider/model`. */
  OPENCODE_MODEL: process.env.OPENCODE_MODEL ?? "",
  /** Optional opencode agent name, passed as --agent. */
  OPENCODE_AGENT: process.env.OPENCODE_AGENT ?? "",
  /**
   * Auto-approve permissions (opencode --auto). Headless runs need this or
   * they block on prompts a TUI would otherwise answer. Dangerous: the agent
   * can run tools without confirmation.
   */
  OPENCODE_AUTO: bool("OPENCODE_AUTO", true),
  /** Run without external plugins (opencode --pure). Predictable baseline. */
  OPENCODE_PURE: bool("OPENCODE_PURE", true),
  /** Forward opencode logs to stderr (opencode --print-logs). */
  OPENCODE_PRINT_LOGS: bool("OPENCODE_PRINT_LOGS", true),
  /** Heartbeat interval (ms) for "still running" trace events while idle. */
  OPENCODE_HEARTBEAT_MS: Number(process.env.OPENCODE_HEARTBEAT_MS ?? 3000),
  /**
   * Run a long-lived `opencode serve` headless server and route every
   * `opencode run` through it via `--attach`. Eliminates the per-request
   * opencode cold start (config load, provider warm-up). When disabled, or if
   * the server fails to start at bootstrap, we fall back to per-request spawn
   * — OPENCODE_SERVER_URL stays empty and buildArgs skips `--attach`.
   */
  OPENCODE_SERVER_ENABLED: bool("OPENCODE_SERVER_ENABLED", true),
  /**
   * Port for `opencode serve`. 0 lets opencode choose — it defaults to its
   * convention port 4096, and falls back to a random port if 4096 is taken.
   * Either way the ready line reports the actual port, so `--attach` always
   * targets the right one. (Verified: serve is a single process whose pid ==
   * the listener; taskkill /T /F cleans it up.)
   */
  OPENCODE_SERVER_PORT: Number(process.env.OPENCODE_SERVER_PORT ?? 0),
  /** Hostname for `opencode serve`. Loopback only — never expose this raw. */
  OPENCODE_SERVER_HOST: process.env.OPENCODE_SERVER_HOST ?? "127.0.0.1",
  /**
   * The `http://host:port` url of the running `opencode serve`. Captured at
   * runtime from the serve process's "listening on …" line and written back
   * here so defaultClientConfig() picks it up. Empty = per-run mode.
   */
  OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL ?? "",
  /** Max ms to wait for `opencode serve` to print its listening url. */
  OPENCODE_SERVER_STARTUP_TIMEOUT_MS: Number(
    process.env.OPENCODE_SERVER_STARTUP_TIMEOUT_MS ?? 10000
  ),
};

if (!ENV.OPENCODE_BIN) {
  // eslint-disable-next-line no-console
  console.warn(
    "[server] OPENCODE_BIN is empty. Set it to the opencode executable path."
  );
}
