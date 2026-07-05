/**
 * opencode subprocess client. Spawns `opencode run --format json` per request
 * and yields a merged stream of: parsed JSON events, stderr lines, heartbeats,
 * and the final exit. The agent runner maps this stream into AgentEvent.
 *
 * Per-run model: each call spawns a fresh opencode process. Multi-turn
 * continuity is achieved by passing `--session <id>` (captured from the first
 * run's events) on subsequent calls — opencode owns the conversation history.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ENV } from "../env.js";
import { parseOpencodeLine, type OpencodeEvent } from "./events.js";

export interface OpencodeClientConfig {
  /** Path to the opencode executable (real .exe on Windows, not a shim). */
  bin: string;
  /** Working directory (--dir). */
  workdir: string;
  /** Optional model override as `provider/model` (-m). */
  model?: string;
  /** Optional opencode agent name (--agent). */
  agent?: string;
  /** Auto-approve permissions (--auto). Headless runs need this. */
  auto: boolean;
  /** Run without external plugins (--pure). */
  pure: boolean;
  /** Forward opencode logs to stderr (--print-logs). */
  printLogs: boolean;
  /** "Still running" trace interval while the child produces no output. */
  heartbeatMs: number;
}

export function defaultClientConfig(): OpencodeClientConfig {
  return {
    bin: ENV.OPENCODE_BIN,
    workdir: ENV.OPENCODE_WORKDIR,
    model: ENV.OPENCODE_MODEL || undefined,
    agent: ENV.OPENCODE_AGENT || undefined,
    auto: ENV.OPENCODE_AUTO,
    pure: ENV.OPENCODE_PURE,
    printLogs: ENV.OPENCODE_PRINT_LOGS,
    heartbeatMs: ENV.OPENCODE_HEARTBEAT_MS,
  };
}

/** One item emitted by the merged child-process stream. */
export type OpencodeStreamItem =
  | { kind: "event"; event: OpencodeEvent }
  | { kind: "stderr"; line: string }
  | { kind: "heartbeat"; elapsedMs: number }
  | { kind: "exit"; code: number | null; spawnError?: Error };

export interface OpencodeRunOptions {
  /** Continue an existing opencode session by id (--session). */
  session?: string;
  /** Continue opencode's last session (--continue). Mutually exclusive with session. */
  continueLast?: boolean;
  /** User message for this turn. Omit only when continuing without a turn. */
  message?: string;
}

export class OpencodeClient {
  readonly config: OpencodeClientConfig;

  constructor(config: Partial<OpencodeClientConfig> = {}) {
    this.config = { ...defaultClientConfig(), ...config };
  }

  private buildArgs(opts: OpencodeRunOptions): string[] {
    const c = this.config;
    const args = ["run", "--format", "json"];
    if (c.auto) args.push("--auto");
    if (c.pure) args.push("--pure");
    if (c.printLogs) args.push("--print-logs");
    if (c.workdir) args.push("--dir", c.workdir);
    if (opts.session) args.push("--session", opts.session);
    else if (opts.continueLast) args.push("--continue");
    if (c.model) args.push("-m", c.model);
    if (c.agent) args.push("--agent", c.agent);
    if (opts.message) args.push(opts.message);
    return args;
  }

  async *run(opts: OpencodeRunOptions = {}): AsyncIterable<OpencodeStreamItem> {
    const c = this.config;
    const args = this.buildArgs(opts);

    let child: ChildProcess;
    try {
      // IMPORTANT: never use shell:true. On Windows, passing a multi-line
      // message through cmd.exe mangles argv and opencode hangs on a broken
      // prompt. Require OPENCODE_BIN to point at a real executable so Node can
      // pass argv verbatim.
      //
      // stdin MUST be 'ignore' (not the default 'pipe'). opencode's `run`
      // command hangs after init when stdin is an open, non-TTY pipe that never
      // closes. /devnull (EOF) unblocks it.
      child = spawn(c.bin, args, {
        cwd: c.workdir || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      yield { kind: "exit", code: null, spawnError: err as Error };
      return;
    }

    // Async spawn errors (ENOENT etc.) arrive on the "error" event. Without a
    // listener Node would crash. Capture and surface via a final exit item.
    let spawnError: Error | null = null;
    let exited = false;
    const queue: OpencodeStreamItem[] = [];
    let resolveNext: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const startedAt = Date.now();

    const push = (item: OpencodeStreamItem) => {
      queue.push(item);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    const finish = (item: OpencodeStreamItem) => {
      if (exited) return;
      exited = true;
      if (heartbeat) clearInterval(heartbeat);
      push(item);
    };

    const attachLineReader = (
      stream: NodeJS.ReadableStream,
      kind: "event" | "stderr"
    ) => {
      let buf = "";
      const emit = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (kind === "stderr") {
          push({ kind: "stderr", line });
          return;
        }
        const event = parseOpencodeLine(line);
        if (event) push({ kind: "event", event });
      };
      stream.on("data", (chunk: Buffer | string) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          emit(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      });
      stream.on("end", () => {
        if (buf.trim()) emit(buf);
      });
    };

    // stdio is ["ignore","pipe","pipe"], so stdout/stderr are always non-null
    // at runtime; the guards only satisfy the ChildProcess type.
    if (child.stdout) attachLineReader(child.stdout, "event");
    if (child.stderr) attachLineReader(child.stderr, "stderr");

    heartbeat = setInterval(() => {
      push({ kind: "heartbeat", elapsedMs: Date.now() - startedAt });
    }, c.heartbeatMs);

    child.on("error", (err) => {
      spawnError = err;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ kind: "exit", code: null, spawnError: err });
    });

    child.on("exit", (code) => {
      finish({ kind: "exit", code });
    });

    try {
      while (true) {
        // Wait while the queue is empty and the child hasn't exited.
        while (queue.length === 0 && !exited) {
          await new Promise<void>((r) => (resolveNext = r));
        }
        if (queue.length === 0) return; // exited with nothing left to drain
        const item = queue.shift()!;
        yield item;
        if (item.kind === "exit") return;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
