/**
 * In-process session store. Each session tracks the opencode session id so
 * subsequent turns continue the same opencode conversation (--session).
 *
 * opencode owns the full conversation history; we only hold the id. Use
 * `opencode export <id>` if you need the transcript. Sessions are not
 * persistent — cleared on restart.
 *
 * The `messages` log is a thin local view of what we sent into opencode,
 * useful for debugging and as a fallback if we ever stop relying on
 * opencode's own session history.
 */

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface Session {
  sessionId: string;
  /** opencode-assigned session id, populated on the first run. */
  opencodeSessionId?: string;
  createdAt: number;
  /** Ordered transcript of messages we sent into opencode. */
  messages: SessionMessage[];
}

const sessions = new Map<string, Session>();

export function getOrCreateSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { sessionId, createdAt: Date.now(), messages: [] };
    sessions.set(sessionId, s);
  }
  return s;
}

export function setOpencodeSessionId(sessionId: string, opencodeSessionId: string) {
  const s = getOrCreateSession(sessionId);
  if (!s.opencodeSessionId) s.opencodeSessionId = opencodeSessionId;
}

export function appendMessage(sessionId: string, msg: SessionMessage) {
  const s = getOrCreateSession(sessionId);
  s.messages.push(msg);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}

export function dropSession(sessionId: string) {
  sessions.delete(sessionId);
}
