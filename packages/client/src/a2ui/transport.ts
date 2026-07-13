/**
 * SSE transport. We use fetch + ReadableStream (NOT EventSource) because we
 * need to POST a body to start the stream.
 */

import type { A2UIEnvelope, ActionPayload } from "@a2ui/protocol";
import { snapshotSurfaceDataModels, useA2UI, type AgentSelection } from "./store.js";

interface SSEHandlers {
  onEnvelope: (env: A2UIEnvelope) => void;
  onText?: (data: { text: string }) => void;
  onReasoning?: (data: { text: string }) => void;
  onTrace?: (data: { message: string }) => void;
  onToolCall?: (data: { id: string; name: string; args: unknown }) => void;
  onToolResult?: (data: { id: string; name: string; result?: unknown; error?: string }) => void;
  onError?: (err: { code: string; message: string }) => void;
  onDone?: () => void;
}

async function postSSE(url: string, body: unknown, handlers: SSEHandlers) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let doneCalled = false;
  const done = () => {
    if (!doneCalled) {
      doneCalled = true;
      handlers.onDone?.();
    }
  };

  if (!res.ok || !res.body) {
    handlers.onError?.({
      code: "HTTP_ERROR",
      message: `${res.status} ${res.statusText}`,
    });
    done();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      processFrame(frame, handlers, done);
    }
  }
  done();
}

function parseJSON<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

function processFrame(frame: string, handlers: SSEHandlers, done: () => void) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;

  if (event === "a2ui") {
    // Server batches one or more envelopes per a2ui frame under `envelopes`.
    const parsed = parseJSON<{ envelopes: A2UIEnvelope[] }>(data);
    if (parsed?.envelopes) {
      for (const env of parsed.envelopes) handlers.onEnvelope(env);
    }
  } else if (event === "text") {
    const parsed = parseJSON<{ text: string }>(data);
    if (parsed) handlers.onText?.(parsed);
  } else if (event === "reasoning") {
    const parsed = parseJSON<{ text: string }>(data);
    if (parsed) handlers.onReasoning?.(parsed);
  } else if (event === "trace") {
    const parsed = parseJSON<{ message: string }>(data);
    if (parsed) handlers.onTrace?.(parsed);
  } else if (event === "tool_call") {
    const parsed = parseJSON<{ id: string; name: string; args: unknown }>(data);
    if (parsed) handlers.onToolCall?.(parsed);
  } else if (event === "tool_result") {
    const parsed = parseJSON<{ id: string; name: string; result?: unknown; error?: string }>(data);
    if (parsed) handlers.onToolResult?.(parsed);
  } else if (event === "error") {
    const parsed = parseJSON<{ code: string; message: string }>(data);
    handlers.onError?.(parsed ?? { code: "PARSE_ERROR", message: data });
  } else if (event === "done") {
    done();
  }
}

function makeHandlers() {
  const { applyEnvelope, appendAgentText, appendReasoning, setBusy, pushConversation } = useA2UI.getState();
  return {
    onEnvelope: (env: A2UIEnvelope) => applyEnvelope(env),
    onText: (data: { text: string }) => appendAgentText(data.text),
    onReasoning: (data: { text: string }) => appendReasoning(data.text),
    onTrace: (data: { message: string }) =>
      pushConversation({ type: "trace", message: data.message }),
    onToolCall: (data: { id: string; name: string; args: unknown }) =>
      pushConversation({
        type: "tool_call",
        callId: data.id,
        name: data.name,
        args: data.args,
      }),
    onToolResult: (data: { id: string; name: string; result?: unknown; error?: string }) =>
      pushConversation({
        type: "tool_result",
        callId: data.id,
        name: data.name,
        result: data.result,
        error: data.error,
      }),
    onError: (err: { code: string; message: string }) =>
      pushConversation({ type: "error", code: err.code, message: err.message }),
    onDone: () => setBusy(false),
  } satisfies SSEHandlers;
}

/** Strip empty buckets so the backend payload stays compact. */
function compactSelection(s: AgentSelection): AgentSelection | undefined {
  const out: AgentSelection = { agents: s.agents, skills: s.skills, mcps: s.mcps };
  const hasAny = out.agents.length + out.skills.length + out.mcps.length > 0;
  return hasAny ? out : undefined;
}

/**
 * Upload a `data:` URI (e.g. a base64 image from a file input or an inline
 * markdown image) to the server's MinIO store and return its `/api/files/...`
 * url. Returns null on any failure - callers fall back to the original. Shared
 * by the Markdown image capture and the chat-input attachment flow.
 */
const uploadCache = new Map<string, string>();

export async function uploadImage(dataUri: string): Promise<string | null> {
  if (uploadCache.has(dataUri)) return uploadCache.get(dataUri)!;
  try {
    const res = await fetch("/api/images/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dataUri }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok: boolean; url?: string };
    if (!data.url) return null;
    uploadCache.set(dataUri, data.url);
    return data.url;
  } catch {
    return null;
  }
}

/**
 * Image attachment passed alongside the chat message. `url` is the server-side
 * `/api/files/...` path produced by `uploadImage()`. `mimeType` is optional
 * (server figures it out from the URL); pass it when known to skip a server
 * round-trip on lookup.
 */
export interface ChatAttachment {
  url: string;
  mimeType?: string;
}

export async function sendChat(
  message: string,
  attachments: ChatAttachment[] = []
) {
  const { sessionId, opencodeSessionId, setBusy, pushConversation, selection } =
    useA2UI.getState();
  pushConversation({ type: "user_message", text: message });
  setBusy(true);
  await postSSE(
    "/api/chat",
    {
      sessionId,
      message,
      selection: compactSelection(selection),
      ...(opencodeSessionId ? { opencodeSessionId } : {}),
      ...(attachments.length ? { attachments } : {}),
    },
    makeHandlers()
  );
}

export async function sendAction(
  surfaceId: string,
  name: string,
  sourceComponentId: string | undefined,
  context: Record<string, unknown>
) {
  const { sessionId, opencodeSessionId, setBusy, pushConversation, surfaces, selection } =
    useA2UI.getState();

  const action: ActionPayload = {
    name,
    surfaceId,
    sourceComponentId,
    timestamp: new Date().toISOString(),
    context,
  };

  if (surfaces[surfaceId]?.sendDataModel) {
    action.a2uiClientDataModel = { surfaces: snapshotSurfaceDataModels() };
  }

  pushConversation({ type: "system_message", text: `→ action ${name} on ${surfaceId}` });
  setBusy(true);

  await postSSE(
    "/api/action",
    {
      sessionId,
      action,
      selection: compactSelection(selection),
      ...(opencodeSessionId ? { opencodeSessionId } : {}),
    },
    makeHandlers()
  );
}

/** Abort the in-flight turn for the current session. Best-effort. */
export async function cancelChat(): Promise<void> {
  const { sessionId, busy, setBusy } = useA2UI.getState();
  if (!busy) return;
  // Optimistic: unblock the UI immediately; the stream will end naturally or
  // server will close on cancel.
  setBusy(false);
  try {
    await fetch("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    /* best-effort */
  }
}
