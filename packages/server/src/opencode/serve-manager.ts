/**
 * Long-lived `opencode serve` lifecycle manager.
 *
 * Spawns one headless opencode server at bootstrap, waits for it to print its
 * listening url, and writes that url back into ENV.OPENCODE_SERVER_URL so
 * defaultClientConfig() picks it up — every subsequent `opencode run` then
 * attaches to this server instead of cold-starting a fresh opencode instance.
 *
 * If the server fails to boot (spawn error, early exit, timeout),
 * startOpencodeServer resolves null and ENV.OPENCODE_SERVER_URL stays empty:
 * the system silently falls back to per-request spawn. No hard failure —
 * cold-start avoidance is a perf optimization, not a correctness requirement.
 *
 * Process-tree cleanup is mandatory on Windows: child.kill() does not reach
 * grandchildren, so a crashed parent leaves a ghost opencode.exe holding the
 * port (the exact problem we hit during testing). We use `taskkill /T /F /PID`
 * to take the whole tree down synchronously on exit.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { ENV } from "../env.js";

export interface OpencodeServerHandle {
  url: string;
  child: ChildProcess;
}

/** Matches opencode serve's "listening on http://host:port" ready line. */
const READY_PATTERN = /listening on (http:\/\/\S+)/;

function attachLineReader(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void
) {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      onLine(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buf.trim()) onLine(buf);
  });
}

/**
 * Spawn `opencode serve` and resolve once it prints its listening url.
 * Resolves null on spawn error / early exit / timeout — caller then falls back
 * to per-request spawn. On success, ENV.OPENCODE_SERVER_URL is set so clients
 * pick up `--attach` automatically.
 */
export async function startOpencodeServer(): Promise<OpencodeServerHandle | null> {
  if (!ENV.OPENCODE_SERVER_ENABLED) {
    process.stderr.write(
      "[serve] disabled (OPENCODE_SERVER_ENABLED=false), using per-run spawn\n"
    );
    return null;
  }

  const args = [
    "serve",
    "--port", String(ENV.OPENCODE_SERVER_PORT),
    "--hostname", ENV.OPENCODE_SERVER_HOST,
  ];
  if (ENV.OPENCODE_PURE) args.push("--pure");
  if (ENV.OPENCODE_PRINT_LOGS) args.push("--print-logs");

  let child: ChildProcess;
  try {
    child = spawn(ENV.OPENCODE_BIN, args, {
      cwd: ENV.OPENCODE_WORKDIR || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch (err) {
    process.stderr.write(`[serve] spawn failed: ${(err as Error).message}\n`);
    return null;
  }

  return new Promise<OpencodeServerHandle | null>((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (handle: OpencodeServerHandle | null, msg: string) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      process.stderr.write(`[serve] ${msg}\n`);
      if (!handle) {
        // Best-effort cleanup of the partial spawn so it can't go ghost.
        killProcessTree(child);
      }
      resolve(handle);
    };

    // The ready line goes to stdout; surface stderr for debugging too.
    attachLineReader(child.stdout, (line) => {
      const m = line.match(READY_PATTERN);
      if (m && !resolved) {
        const url = m[1];
        ENV.OPENCODE_SERVER_URL = url;
        finish({ url, child }, `opencode server ready at ${url}`);
      }
    });
    attachLineReader(child.stderr, (line) => {
      const trimmed = line.trim();
      if (trimmed) process.stderr.write(`[serve:stderr] ${trimmed}\n`);
    });

    child.on("error", (err) => {
      finish(null, `spawn error: ${err.message}`);
    });
    child.on("exit", (code) => {
      finish(null, `exited before ready (code=${code})`);
    });

    timer = setTimeout(() => {
      finish(null, `startup timeout after ${ENV.OPENCODE_SERVER_STARTUP_TIMEOUT_MS}ms`);
    }, ENV.OPENCODE_SERVER_STARTUP_TIMEOUT_MS);
  });
}

/**
 * Kill the serve process and (on Windows) its entire descendant tree.
 * `child.kill()` only signals the direct child; grandchildren survive and hold
 * the port — the ghost-process problem we hit before.
 */
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // /T = kill descendants, /F = force. spawnSync so it completes before return.
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Stop a previously started server handle (whole process tree). */
export function stopOpencodeServer(handle: OpencodeServerHandle | null): void {
  if (!handle) return;
  killProcessTree(handle.child);
}
