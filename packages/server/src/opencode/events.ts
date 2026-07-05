/**
 * Raw opencode wire format (stdout of `opencode run --format json`).
 *
 * opencode emits one JSON object per line (NDJSON). Each top-level object has
 * a `type` (step_start | step_finish | tool_use | text | reasoning | error |
 * ...) and an optional `part` carrying the payload. We type only the fields we
 * consume; everything else passes through as `unknown`.
 *
 * These types describe opencode's output as-is — no A2UI, no normalization.
 * The agent runner is responsible for mapping these to the public AgentEvent.
 */

export interface OpencodePartState {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface OpencodePart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  reason?: string;
  state?: OpencodePartState;
}

export interface OpencodeEvent {
  type: string;
  sessionID?: string;
  part?: OpencodePart;
}

/** Parse a single stdout line into an opencode event, or undefined if blank/non-JSON. */
export function parseOpencodeLine(line: string): OpencodeEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as OpencodeEvent;
  } catch {
    return undefined;
  }
}

/**
 * Reasoning block delimiters. Each is an [open, close] pair.
 *
 * MiniMax / Qwen thinking mode emits ``...`` which is awkward to embed
 * literally in source (markdown / linters eat backticks), so we build that
 * pair via String.fromCharCode(96). The other two variants are plain literals.
 */
const THINKING_TAGS: ReadonlyArray<readonly [string, string]> = (() => {
  const b = String.fromCharCode(96); // "`"
  const xnOpen = b + b + b + "think" + b; // ```
  const xnClose = b + "think" + b + b + b; // ```
  return [
    [xnOpen, xnClose],
    ["<thinking>", "</thinking>"],
    ["【思考】", "【/思考】"],
  ];
})();

/**
 * Strip thinking-block content (open tag, content, close tag — all removed).
 * Returns the text with every matched `OPEN ... CLOSE` pair excised. If an
 * open tag has no matching close, we leave everything as-is: leaking one stray
 * opener is better than silently swallowing the rest of the answer.
 *
 * Caps at 64 replacements per tag kind per call as a runaway guard.
 */
export function stripThinking(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [open, close] of THINKING_TAGS) {
    let safety = 64;
    while (safety-- > 0) {
      const start = out.indexOf(open);
      if (start < 0) break;
      const end = out.indexOf(close, start + open.length);
      if (end < 0) break;
      out = out.slice(0, start) + out.slice(end + close.length);
    }
  }
  return out;
}
