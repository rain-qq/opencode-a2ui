/**
 * opencode ACP (Agent Client Protocol) client.
 *
 * One long-lived `opencode acp` subprocess acts as a JSON-RPC 2.0 peer over
 * stdio (newline-delimited JSON, one message per line). We speak ACP instead
 * of the ad-hoc `opencode run --format json` NDJSON: multi-turn continuity is
 * native (`session/load`), session lifecycle (list/fork/resume/close) is
 * first-class, and reasoning is an explicit content type (no more
 * strip-thinking heuristics).
 *
 * Lifecycle:
 *  - initialize()        once, at peer startup — negotiate protocol + caps
 *  - sessionNew/load()   create or resume an opencode session → sessionId
 *  - sessionPrompt()     send a user turn, async-iterate the streamed
 *                         `session/update` notifications, then the request
 *                         resolves with {stopReason, usage}
 *  - sessionCancel()     interrupt an in-flight prompt (e.g. on SSE disconnect)
 *
 * Request/response correlation is by JSON-RPC `id`. Notifications (no `id`)
 * carry `params.sessionId` and are routed to that session's active prompt sink.
 *
 * Verified against opencode acp v1.17.13 (see plan: opencode-acp-migration).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ENV } from "../env.js";
import { killProcessTree } from "./process-tree.js";

export interface AcpClientConfig {
  /** Path to the opencode executable (real .exe on Windows, not a shim). */
  bin: string;
  /** Working directory passed via --cwd (also re-sent in session/new). */
  workdir: string;
  /** Run without external plugins (--pure). Predictable baseline. */
  pure: boolean;
  /** Forward opencode logs to stderr (--print-logs). Debug only. */
  printLogs: boolean;
}

export function defaultAcpClientConfig(): AcpClientConfig {
  return {
    bin: ENV.OPENCODE_BIN,
    workdir: ENV.OPENCODE_WORKDIR,
    pure: ENV.OPENCODE_PURE,
    printLogs: ENV.OPENCODE_PRINT_LOGS,
  };
}

// --- ACP wire types (only the fields we consume; the rest is `unknown`) ---

export interface AcpAgentInfo {
  name?: string;
  version?: string;
}

export interface AcpCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { embeddedContext?: boolean; image?: boolean };
  sessionCapabilities?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: AcpCapabilities;
  agentInfo?: AcpAgentInfo;
  authMethods?: Array<{ id: string; name: string; description?: string }>;
}

export interface AcpSessionSummary {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
}

export interface AcpSessionListResult {
  sessions: AcpSessionSummary[];
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name: string; description?: string }>;
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptFinal {
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedReadTokens?: number;
  };
  _meta?: Record<string, unknown>;
}

/**
 * One `session/update` notification's `update` payload. Discriminated by
 * `sessionUpdate`. We type only the fields we read in the mapper; everything
 * else passes through as `unknown` (matches the loose-typing style of the old
 * events.ts for external wire data).
 *
 * Known discriminants (opencode v1.17.13):
 *  - agent_message_chunk   → streamed text/reasoning content
 *  - tool_call             → tool call start (status "pending")
 *  - tool_call_update      → tool progress/result (status in_progress|completed|error)
 *  - available_commands_update → skill/command list (ignored in plan A)
 */
export interface AcpUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** A JSON-RPC error response. */
export interface AcpRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * One prompt part. ACP prompts are arrays of typed content blocks; we emit
 * `text` for the user message and `image` for file attachments.
 *
 * ACP's `ImageContent` only accepts INLINE base64 — it has no URL variant.
 * So the runner (not the HTTP layer) pulls the image bytes from MinIO, base64
 * encodes them, and stuffs them in `data`. Keeping the fetch here means the
 * HTTP boundary only deals with `/api/files/...` refs (no buffer movement
 * through SSE); the expensive base64 serialization happens once per turn,
 * adjacent to the consumer that needs it.
 */
export type AcpPromptPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: AcpRpcError | Error) => void;
}

/** Push/close/throw queue backing a sessionPrompt async iterator. */
interface PromptSink {
  push: (item: AcpUpdate) => void;
  close: () => void;
  error: (err: Error) => void;
  iterate: () => AsyncIterable<AcpUpdate>;
}

export class AcpClient {
  readonly config: AcpClientConfig;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private sinks = new Map<string, PromptSink>();
  private initialized = false;
  /** Set once the child exits or errors; further calls reject immediately. */
  private dead: Error | null = null;

  constructor(config: Partial<AcpClientConfig> = {}) {
    this.config = { ...defaultAcpClientConfig(), ...config };
  }

  /** Spawn the `opencode acp` peer and perform the initialize handshake. */
  async initialize(): Promise<AcpInitializeResult> {
    if (this.initialized) {
      throw new Error("AcpClient.initialize() called twice");
    }
    this.spawn();
    // `initialize` is a request, so it goes through send() — but we must send
    // it after the stdout reader is attached (spawn() does that).
    const result = await this.send<AcpInitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "a2ui-server", version: "0.1.0" },
      clientCapabilities: {},
    });
    // NOTE: opencode acp returns "method not found" for the LSP-style
    // `notifications/initialized` — do NOT send it.
    this.initialized = true;
    return result;
  }

  private spawn(): void {
    const c = this.config;
    const args = ["acp"];
    if (c.pure) args.push("--pure");
    if (c.printLogs) args.push("--print-logs");
    if (c.workdir) args.push("--cwd", c.workdir);

    // shell:false + real exe path so argv is passed verbatim (Windows safety,
    // same rule as the old `opencode run` client). stdin is a pipe: we write
    // JSON-RPC requests into it. Keeping stdin open is what keeps the peer
    // alive — EOF disposes the opencode instance.
    this.child = spawn(c.bin, args, {
      cwd: c.workdir || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    this.attachLineReader(this.child.stdout, (line) => this.onLine(line));
    // opencode's own runtime logs (--print-logs) land on stderr; echo for
    // local debugging, the same way serve-manager does.
    this.attachLineReader(this.child.stderr, (line) => {
      const trimmed = line.trim();
      if (trimmed) process.stderr.write(`[acp] ${trimmed}\n`);
    });

    this.child.on("error", (err) => this.die(err));
    this.child.on("exit", (code) => {
      this.die(
        new Error(
          `opencode acp exited (code=${code}). ` +
            (code === null ? "Killed by signal." : "") +
            " All in-flight prompts have been failed."
        )
      );
    });
  }

  private attachLineReader(
    stream: NodeJS.ReadableStream | null,
    onLine: (line: string) => void
  ): void {
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

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // non-JSON line — ignore (shouldn't happen with --print-logs on stderr)
    }
    if (msg && msg.id !== undefined && msg.id !== null) {
      // Response to a request.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(msg.error as AcpRpcError);
      else p.resolve(msg.result);
    } else if (msg && msg.method) {
      // Notification. Route session/update to the active prompt sink for its
      // sessionId; everything else is ignored (opencode acp currently only
      // emits session/update during a prompt).
      this.routeNotification(msg);
    }
  }

  private routeNotification(msg: { method: string; params?: any }): void {
    if (msg.method !== "session/update") return;
    const params = msg.params ?? {};
    const sessionId: string | undefined = params.sessionId;
    const update: AcpUpdate | undefined = params.update;
    if (!sessionId || !update) return;
    const sink = this.sinks.get(sessionId);
    if (sink) sink.push(update);
    // No sink = the prompt already ended (or was cancelled). Drop silently.
  }

  /** Send a JSON-RPC request and await its result. Rejects on RPC error. */
  private send<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    if (!this.child || !this.child.stdin) {
      return Promise.reject(new Error("acp peer not spawned"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      try {
        this.child!.stdin!.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
        );
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Create a new opencode session. */
  sessionNew(
    cwd: string = this.config.workdir,
    mcpServers: unknown[] = []
  ): Promise<AcpSessionNewResult> {
    return this.send<AcpSessionNewResult>("session/new", { cwd, mcpServers });
  }

  /** Resume an existing opencode session by id. */
  sessionLoad(
    sessionId: string,
    cwd: string = this.config.workdir,
    mcpServers: unknown[] = []
  ): Promise<unknown> {
    // session/load result shape is not strictly typed; we only need it to
    // succeed (the sessionId is already known to the caller).
    return this.send("session/load", { sessionId, cwd, mcpServers });
  }

  /** List known opencode sessions (newest first). */
  sessionList(): Promise<AcpSessionListResult> {
    return this.send<AcpSessionListResult>("session/list", {});
  }

  /** Cancel an in-flight prompt on the given session. */
  sessionCancel(sessionId: string): Promise<unknown> {
    return this.send("session/cancel", { sessionId }).catch(() => {
      // Cancel is best-effort: if the prompt already finished, the RPC errors.
    });
  }

  /**
   * Send a user turn and async-iterate the streamed `session/update`
   * notifications (each `update` payload). The iterator ends when the
   * `session/prompt` request resolves (turn finished); it throws if the
   * request errors (RPC error / peer death). The runner's for-await + try/catch
   * maps that to an AgentEvent error.
   */
  async *sessionPrompt(
    sessionId: string,
    prompt: AcpPromptPart[]
  ): AsyncIterable<AcpUpdate> {
    if (this.dead) throw this.dead;
    const sink = this.createSink();
    this.sinks.set(sessionId, sink);

    const resultP = this.send<AcpPromptFinal>("session/prompt", {
      sessionId,
      prompt,
    });
    // Close the sink exactly once: on success (iterator drains then ends) or
    // on error (iterator throws). Swallow the rejection so it surfaces via
    // sink.error instead of as an unhandled rejection.
    resultP.then(
      () => sink.close(),
      (err) => sink.error(err)
    );

    try {
      for await (const upd of sink.iterate()) yield upd;
    } finally {
      this.sinks.delete(sessionId);
    }
  }

  private createSink(): PromptSink {
    const queue: AcpUpdate[] = [];
    let resolveNext: (() => void) | null = null;
    let closed = false;
    let thrown: Error | null = null;

    const drainCheck = () => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    return {
      push: (item) => {
        if (closed) return;
        queue.push(item);
        drainCheck();
      },
      close: () => {
        if (closed) return;
        closed = true;
        drainCheck();
      },
      error: (err) => {
        if (closed) return;
        thrown = err;
        closed = true;
        drainCheck();
      },
      iterate: async function* (): AsyncIterable<AcpUpdate> {
        while (true) {
          while (queue.length === 0 && !closed) {
            await new Promise<void>((r) => (resolveNext = r));
          }
          if (queue.length > 0) {
            yield queue.shift()!;
            continue;
          }
          // queue empty + closed
          if (thrown) throw thrown;
          return;
        }
      },
    };
  }

  /** Kill the peer (whole process tree on Windows) and fail all callers. */
  private die(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const [, sink] of this.sinks) sink.error(err);
    this.sinks.clear();
    if (this.child) killProcessTree(this.child);
  }

  /** Stop the peer. Safe to call multiple times. */
  dispose(): void {
    if (this.child) killProcessTree(this.child);
    this.die(new Error("AcpClient disposed"));
  }
}
