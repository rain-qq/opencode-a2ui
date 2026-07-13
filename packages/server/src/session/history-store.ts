/**
 * File-based conversation history store. Survives server restarts (unlike the
 * in-memory session/store.ts which only holds the opencode-session-id mapping).
 *
 * Layout under <workspace>/.a2ui/:
 *   history.json                - array of HistoryEntry (metadata, newest-first
 *                                 on read)
 *   transcripts/<id>.jsonl      - one HistoryTranscriptItem per line (append-
 *                                 only, crash-safe; read splits on newlines)
 *
 * The transcript is a compact, JSON-serializable echo of what the client saw -
 * enough to replay the textual timeline on resume. Surfaces are stored as
 * lightweight markers (`{type:"surface"}`) and rendered as archived cards by
 * the client; their full component graph is NOT replayed (MVP). opencode keeps
 * the real model context via session/load, so the model still "remembers".
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { workspaceRoot } from "../env.js";

export interface HistoryEntry {
  /** Client session id (sess_...). Primary key. */
  id: string;
  /** opencode/ACP session id (ses_...). Used to resume via session/load. */
  opencodeSessionId: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryTranscriptItem {
  type:
    | "user_message"
    | "assistant_text"
    | "reasoning"
    | "trace"
    | "tool_call"
    | "tool_result"
    | "error"
    | "surface";
  ts: number;
  text?: string;
  message?: string;
  callId?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  code?: string;
  surfaceId?: string;
  archived?: boolean;
}

const DATA_DIR = resolve(workspaceRoot, ".a2ui");
const HISTORY_FILE = resolve(DATA_DIR, "history.json");
const TRANSCRIPTS_DIR = resolve(DATA_DIR, "transcripts");

function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function transcriptPath(id: string): string {
  return resolve(TRANSCRIPTS_DIR, `${id}.jsonl`);
}

function readHistoryRaw(): HistoryEntry[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const txt = readFileSync(HISTORY_FILE, "utf-8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? (arr as HistoryEntry[]) : [];
  } catch (err) {
    process.stderr.write(
      `[history] read history.json failed: ${(err as Error).message}\n`
    );
    return [];
  }
}

function writeHistoryRaw(entries: HistoryEntry[]): void {
  ensureDirs();
  writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

/** List all history entries, newest first. */
export function listHistory(): HistoryEntry[] {
  return readHistoryRaw().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Get one entry (without transcript). */
export function getHistory(id: string): HistoryEntry | undefined {
  return readHistoryRaw().find((e) => e.id === id);
}

/** Read the full transcript for a session (empty array if none/missing). */
export function readTranscript(id: string): HistoryTranscriptItem[] {
  const path = transcriptPath(id);
  if (!existsSync(path)) return [];
  try {
    const txt = readFileSync(path, "utf-8");
    const out: HistoryTranscriptItem[] = [];
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as HistoryTranscriptItem);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Append one transcript item (JSONL line). Creates the file if missing. */
export function appendTranscriptItem(id: string, item: HistoryTranscriptItem): void {
  ensureDirs();
  try {
    appendFileSync(transcriptPath(id), JSON.stringify(item) + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(
      `[history] append transcript (${id}) failed: ${(err as Error).message}\n`
    );
  }
}

/**
 * Create or update a history entry. On create, records the opencode session id
 * and timestamps; on update, refreshes updatedAt + (optionally) title/preview.
 */
export function upsertHistory(
  id: string,
  opencodeSessionId: string,
  patch?: { title?: string; preview?: string }
): HistoryEntry {
  const entries = readHistoryRaw();
  let entry = entries.find((e) => e.id === id);
  const now = Date.now();
  if (!entry) {
    entry = {
      id,
      opencodeSessionId,
      title: patch?.title ?? "新对话",
      preview: patch?.preview ?? "",
      createdAt: now,
      updatedAt: now,
    };
    entries.push(entry);
  } else {
    if (opencodeSessionId) entry.opencodeSessionId = opencodeSessionId;
    if (patch?.title) entry.title = patch.title;
    if (patch?.preview !== undefined) entry.preview = patch.preview;
    entry.updatedAt = now;
  }
  writeHistoryRaw(entries);
  return entry;
}

/** Rename a history entry's title. */
export function patchHistory(
  id: string,
  patch: { title?: string }
): HistoryEntry | undefined {
  const entries = readHistoryRaw();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return undefined;
  if (patch.title !== undefined) entry.title = patch.title;
  entry.updatedAt = Date.now();
  writeHistoryRaw(entries);
  return entry;
}

/** Delete a history entry + its transcript file. */
export function deleteHistory(id: string): boolean {
  const entries = readHistoryRaw();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;
  entries.splice(idx, 1);
  writeHistoryRaw(entries);
  try {
    const path = transcriptPath(id);
    if (existsSync(path)) rmSync(path);
  } catch {
    /* best-effort */
  }
  return true;
}
