/**
 * Agent runtime. The public "底座" API: take a session + message, return a
 * stream of normalized AgentEvent. Multi-turn continuity comes from ACP's
 * native session/load — the opencode session id is stored per A2UI session and
 * resumed on subsequent turns.
 *
 * This layer owns NO output-format policy (no A2UI, no prompt injection). It
 * faithfully surfaces opencode's own tool / text / reasoning events.
 *
 * Transport: opencode ACP (Agent Client Protocol) over a long-lived stdio
 * JSON-RPC peer — see opencode/acp-client.ts. The peer must be initialized
 * before runAgent is called: the HTTP server's peer-manager does this at
 * bootstrap; the CLI (index.ts) constructs + initializes its own client.
 */

import type { A2UIEnvelope } from "@a2ui/protocol";
import { AcpClient, type AcpPromptPart } from "../opencode/acp-client.js";
import { AcpUpdateMapper } from "../opencode/acp-events.js";
import { getOrCreateSession, setOpencodeSessionId } from "../session/store.js";
import { fetchImageBytes, attachmentUrlToKey } from "../storage/minio.js";

/** Hard cap on per-image bytes we'll base64-encode into the prompt. Anything
 *  larger is dropped with a stderr warning — keeps JSON-RPC payloads bounded. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB

export type AgentEvent =
  | { type: "session"; opencodeSessionId: string }
  | { type: "step_start" }
  | { type: "step_finish"; reason?: string }
  | { type: "tool_call"; id: string; name: string; args?: unknown }
  | { type: "tool_result"; id: string; name: string; result?: unknown; error?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "trace"; message: string }
  | { type: "a2ui"; envelopes: A2UIEnvelope[] }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

export interface RunAgentInput {
  sessionId: string;
  message: string;
  /** Explicitly continue this opencode/ACP session (overrides any stored id). */
  opencodeSessionId?: string;
  /** Continue opencode's most recent session (resolves via session/list). */
  continueLast?: boolean;
  /**
   * Server-side image attachments (must already be uploaded to /api/files/*).
   * Fed to the model as ACP `image` parts in addition to the text message;
   * NOT embedded as markdown in `message`. Caller (http/app.ts) is responsible
   * for rejecting anything that isn't an `/api/files/...` URL.
   */
  attachments?: Array<{ url: string; mimeType?: string }>;
}

export interface RunAgentOptions {
  /** Inject an already-initialized ACP client (CLI uses this). Defaults to the
   *  shared singleton set by the peer-manager (HTTP server). */
  client?: AcpClient;
  /**
   * Optional system-prompt-style instructions prepended only to the first
   * message of a fresh opencode session. Subsequent turns use opencode's own
   * session history, so the override is not re-injected.
   */
  firstMessagePrefix?: string;
}

let sharedClient: AcpClient | undefined;

/** Set by the peer-manager after the long-lived ACP peer is initialized. */
export function setDefaultAcpClient(client: AcpClient): void {
  sharedClient = client;
}

function getDefaultClient(): AcpClient {
  if (!sharedClient) {
    throw new Error(
      "No ACP client. The HTTP server must start the opencode ACP peer " +
        "(startAcpPeer) before handling requests, or pass an explicit client."
    );
  }
  return sharedClient;
}

/**
 * Resolve the opencode/ACP session id for this turn: load an existing one if
 * we have it (stored or explicit), else create new (or continue the most
 * recent session when asked). Returns the sessionId and whether it's a
 * freshly-created session (controls firstMessagePrefix injection).
 */
async function resolveSessionId(
  client: AcpClient,
  input: RunAgentInput
): Promise<{ acpSessionId: string; isNew: boolean }> {
  const stored = input.opencodeSessionId ?? getOrCreateSession(input.sessionId).opencodeSessionId;

  if (stored) {
    // Resume an existing opencode session. Best-effort: if load fails (e.g.
    // the id is stale/gone), fall through to creating a new one rather than
    // killing the turn.
    try {
      await client.sessionLoad(stored);
      return { acpSessionId: stored, isNew: false };
    } catch {
      // Fall through to session/new — surface nothing, the user just gets a
      // fresh turn. (Older sessions may have aged out of opencode's store.)
    }
  }

  if (input.continueLast && !stored) {
    try {
      const list = await client.sessionList();
      const newest = list.sessions[0];
      if (newest) {
        await client.sessionLoad(newest.sessionId);
        return { acpSessionId: newest.sessionId, isNew: false };
      }
    } catch {
      // ignore — fall through to new
    }
  }

  const created = await client.sessionNew();
  return { acpSessionId: created.sessionId, isNew: true };
}

export async function* runAgent(
  input: RunAgentInput,
  opts: RunAgentOptions = {}
): AsyncIterable<AgentEvent> {
  const client = opts.client ?? getDefaultClient();

  process.stderr.write(`[agent] acp bin=${client.config.bin}\n`);

  // Resolve (and persist) the opencode/ACP session id for this turn.
  let acpSessionId: string;
  let isNew: boolean;
  try {
    const r = await resolveSessionId(client, input);
    acpSessionId = r.acpSessionId;
    isNew = r.isNew;
  } catch (err) {
    yield {
      type: "error",
      code: "ACP_SESSION_FAILED",
      message: `Failed to create/load ACP session: ${(err as Error).message}`,
    };
    yield { type: "done" };
    return;
  }

  setOpencodeSessionId(input.sessionId, acpSessionId);
  yield { type: "session", opencodeSessionId: acpSessionId };

  // Inject the prefix only on the very first turn of a new opencode session.
  // opencode carries the conversation forward on subsequent session/load runs,
  // so re-injecting would spam the context window.
  const message =
    isNew && opts.firstMessagePrefix
      ? `${opts.firstMessagePrefix}\n\nUser message:\n${input.message}`
      : input.message;

  yield { type: "step_start" };

  // Build the prompt content: text part + base64-inlined image parts.
  // ACP's ImageContent only accepts inline base64, not URLs — so we fetch each
  // attachment from MinIO and base64-encode it here. Anything that fails to
  // fetch or exceeds MAX_ATTACHMENT_BYTES is dropped with a warning rather
  // than killing the turn (a missing image should still let the text get
  // through, but we'll surface a trace so the user knows).
  const promptParts: AcpPromptPart[] = [{ type: "text", text: message }];
  if (input.attachments?.length) {
    for (const a of input.attachments) {
      const fetched = await fetchImageBytes(a.url);
      if (!fetched) {
        yield {
          type: "trace",
          message: `[attachment] failed to load ${a.url}`,
        };
        continue;
      }
      if (fetched.buf.length > MAX_ATTACHMENT_BYTES) {
        yield {
          type: "trace",
          message: `[attachment] skipping ${a.url}: ${fetched.buf.length} bytes exceeds ${MAX_ATTACHMENT_BYTES} limit`,
        };
        continue;
      }
      promptParts.push({
        type: "image",
        data: fetched.buf.toString("base64"),
        mimeType: fetched.contentType,
      });
    }
  }

  const mapper = new AcpUpdateMapper();
  let stopReason: string | undefined;
  try {
    const stream = client.sessionPrompt(acpSessionId, promptParts);

    for await (const update of stream) {
      for (const ev of mapper.map(update)) yield ev;
    }

    // The stream ended normally — stopReason defaults to "end_turn". (ACP
    // surfaces the precise reason/usage in the session/prompt result, which
    // sessionPrompt swallows; the error path below handles failures.)
    stopReason = "end_turn";
  } catch (err) {
    const e = err as { code?: number; message?: string };
    const message =
      typeof e?.message === "string" ? e.message : "ACP prompt failed";
    yield {
      type: "error",
      code: "ACP_PROMPT_FAILED",
      message,
    };
    yield { type: "step_finish", reason: "error" };
    yield { type: "done" };
    return;
  }

  yield { type: "step_finish", reason: stopReason };
  yield { type: "done" };
}
