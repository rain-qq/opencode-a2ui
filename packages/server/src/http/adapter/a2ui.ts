/**
 * A2UI adapter. Sits on top of the agent runtime and scans streamed `text`
 * events for fenced `` ` `a2ui` `` ... `` ` `` blocks containing JSONL
 * envelopes. Outside the fences is plain text; inside is split into envelopes
 * and yielded as a single batched `a2ui` event.
 *
 * This is the ON-DEMAND lane: plain `text` events are still the default and
 * always pass through. `a2ui` events only appear when the model decided to emit
 * structured UI.
 *
 * Stateful because the fence can span multiple `text` chunks. We buffer until
 * we see the close fence, then emit. The parser is tolerant of malformed JSON
 * (drops bad lines, doesn't poison subsequent ones) and falls back gracefully
 * if the open fence never closes (everything stays text).
 */

import { A2UI_VERSION } from "@a2ui/protocol";
import type { A2UIEnvelope } from "@a2ui/protocol";
import type { AgentEvent } from "../../agent/runner.js";

const FENCE = "a2ui";
/** Always called via local helpers so the regexes don't share lastIndex across
 *  invocations. */
function openRe(): RegExp {
  return new RegExp("```" + FENCE + "\\s*\\n", "g");
}
/**
 * A close fence is the next ``` after the open one. We don't require a
 * trailing newline — model output sometimes ends the fence with ``` followed
 * directly by prose on the same (unusual) line, and we still want to close
 * cleanly.
 */
function closeRe(): RegExp {
  return /```/g;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accept `{items:[...]}` wrappers some LLM tool-schemas emit. */
function unwrapArray<T = unknown>(value: unknown): T[] | undefined {
  if (Array.isArray(value)) return value as T[];
  if (isPlainObject(value)) {
    for (const key of ["item", "items", "values", "list"]) {
      if (Array.isArray(value[key])) return value[key] as T[];
    }
  }
  return undefined;
}

/**
 * Brace-balanced incremental JSON extractor. Buffers characters, emits complete
 * top-level JSON objects as soon as depth returns to 0. Robust to braces
 * inside string literals, escape sequences, and a leading fence.
 */
class JsonObjectStream {
  private queue = "";
  private current = "";
  private depth = 0;
  private inString = false;
  private escape = false;

  push(chunk: string): unknown[] {
    const out: unknown[] = [];
    this.queue += chunk;
    while (this.queue.length > 0) {
      const c = this.queue[0];
      this.queue = this.queue.slice(1);
      if (this.depth === 0 && this.current.length === 0) {
        if (c !== "{" && c !== " " && c !== "\n" && c !== "\t" && c !== "\r")
          continue;
        if (c !== "{") continue;
      }
      this.current += c;
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === "\\") this.escape = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') this.inString = true;
      else if (c === "{") this.depth++;
      else if (c === "}") {
        this.depth--;
        if (this.depth === 0) {
          const slice = this.current.trim();
          this.current = "";
          this.inString = false;
          this.escape = false;
          try {
            out.push(JSON.parse(slice));
          } catch {
            /* drop malformed line */
          }
        }
      }
    }
    return out;
  }

  flush(): unknown[] {
    const trailing = this.current.trim();
    if (!trailing || this.depth !== 0 || this.inString) return [];
    this.current = "";
    try {
      return [JSON.parse(trailing)];
    } catch {
      return [];
    }
  }
}

/**
 * 容错: 把 `[{path, componentId}]` 这种错误形式 unwrap 成 `{path, componentId}`。
 * 协议 [protocol/src/types.ts] 定义的 ChildList 形态只有两种:
 *   - 静态 id 数组
 *   - 裸模板对象 { path, componentId }
 * LLM 偶尔会生成第三种(单元素数组包模板对象),这里统一矫正。
 */
function unwrapChildListArray(children: unknown): unknown {
  if (
    Array.isArray(children) &&
    children.length === 1 &&
    !Array.isArray(children[0]) &&
    children[0] !== null &&
    typeof children[0] === "object" &&
    typeof (children[0] as { path?: unknown }).path === "string" &&
    typeof (children[0] as { componentId?: unknown }).componentId === "string"
  ) {
    return children[0];
  }
  return children;
}

function normalizeEnvelope(env: A2UIEnvelope): A2UIEnvelope | undefined {
  const e: Record<string, unknown> = { ...env };
  if (typeof e.version !== "string") e.version = A2UI_VERSION;
  const uc = e.updateComponents as Record<string, unknown> | undefined;
  if (uc) {
    const list = unwrapArray(uc.components) ?? [];
    const normalizedList = (list as unknown[]).map((comp) => {
      if (!isPlainObject(comp)) return comp;
      const c = comp as Record<string, unknown>;
      return { ...c, children: unwrapChildListArray(c.children) };
    });
    e.updateComponents = { ...uc, components: normalizedList };
  }
  return e as unknown as A2UIEnvelope;
}

function parseEnvelopeJsonl(text: string): A2UIEnvelope[] {
  const parser = new JsonObjectStream();
  const out: A2UIEnvelope[] = [];
  const all = [...parser.push(text), ...parser.flush()];
  for (const obj of all) {
    if (!isPlainObject(obj)) continue;
    const n = normalizeEnvelope(obj as unknown as A2UIEnvelope);
    if (
      n &&
      (n.createSurface ||
        n.updateComponents ||
        n.updateDataModel ||
        n.deleteSurface)
    ) {
      out.push(n);
    }
  }
  return out;
}

/**
 * For each open fence, scan for the matching close. We do a single linear
 * scan over the buffered text and return slices for each fence in order, plus
 * the trailing text after the last fence (or after the only-partial last
 * fence, in which case the partial slice is left in the buffer for the next
 * chunk).
 *
 * Returns:
 *   - emittedBefore: text before the first fence → render as plain text now
 *   - blocks:        complete envelope blocks (ready to parse)
 *   - residual:      text after the last complete fence, kept in buffer
 */
interface FenceScan {
  emittedBefore: string;
  blocks: string[];
  residual: string;
}

/**
 * Match a possibly-incomplete open-fence prefix at the end of `text`
 * (e.g. "```", "```a2", "```a2ui"). Stream chunks often split the opener
 * "```a2ui\n" across two events; we hold the partial prefix back instead of
 * emitting it as text, or the following chunk loses its fence context and
 * the whole envelope leaks out as a (wrongly typed) text event.
 */
function matchTrailingOpenPrefix(text: string): string {
  const m = text.match(/```[a-zA-Z0-9_-]*$/);
  return m ? m[0] : "";
}

function extractFences(buffer: string): FenceScan {
  const result: FenceScan = { emittedBefore: "", blocks: [], residual: "" };
  const OPEN_RE = openRe();
  const CLOSE_RE = closeRe();
  let consumed = 0;
  let foundAny = false;
  while (consumed < buffer.length) {
    OPEN_RE.lastIndex = consumed;
    const open = OPEN_RE.exec(buffer);
    if (!open) break;
    foundAny = true;
    const textBefore = buffer.slice(consumed, open.index);
    let insideStart = open.index + open[0].length;
    // Find the next "```" that isn't itself the start of another ```a2ui
    // fence. The OPEN pattern has trailing "a2ui\n" — anything starting with
    // "```a2ui" right after is the next pair's opener, so skip it.
    while (true) {
      CLOSE_RE.lastIndex = insideStart;
      const close = CLOSE_RE.exec(buffer);
      if (!close) {
        result.emittedBefore += textBefore;
        result.residual = buffer.slice(open.index);
        return result;
      }
      const tail = buffer.slice(close.index, close.index + 7);
      if (tail.startsWith("```" + FENCE + "\n") || tail.startsWith("```" + FENCE + "\r")) {
        // That's the next pair's opener; keep scanning.
        insideStart = close.index + 3;
        continue;
      }
      result.emittedBefore += textBefore;
      result.blocks.push(buffer.slice(insideStart, close.index));
      consumed = close.index + 3;
      break;
    }
  }
  if (!foundAny) {
    // No complete open fence anywhere. But the tail of the buffer may be a
    // split opener ("```a2"...) whose "ui\n..." arrives in the next chunk.
    // Hold it back instead of emitting it as text - otherwise the following
    // chunk has no fence context and the envelope leaks out as plain text.
    const held = matchTrailingOpenPrefix(buffer);
    result.emittedBefore = held
      ? buffer.slice(0, buffer.length - held.length)
      : buffer;
    result.residual = held;
    return result;
  }
  // Outer loop exited because no further open fence exists. Anything left
  // between `consumed` and end of buffer is plain text — flush. Same
  // split-opener guard applies to this trailing text.
  const tailText = buffer.slice(consumed);
  const heldTail = matchTrailingOpenPrefix(tailText);
  if (heldTail) {
    result.emittedBefore += tailText.slice(0, tailText.length - heldTail.length);
    result.residual = heldTail;
  } else {
    result.emittedBefore += tailText;
  }
  return result;
}

export async function* withA2UIAdapter(
  events: AsyncIterable<AgentEvent>
): AsyncIterable<AgentEvent> {
  let buffer = "";
  let inFence = false;

  for await (const ev of events) {
    if (ev.type !== "text") {
      // Flush any pending plain-text residual before a non-text event so the
      // client keeps the original order (text → tool_call → text, etc.).
      if (buffer && !inFence) {
        yield { type: "text", text: buffer };
        buffer = "";
      }
      yield ev;
      continue;
    }

    buffer += ev.text;
    const scan = extractFences(buffer);

    if (scan.emittedBefore.length > 0) {
      yield { type: "text", text: scan.emittedBefore };
    }
    for (const block of scan.blocks) {
      const envelopes = parseEnvelopeJsonl(block);
      if (envelopes.length > 0) {
        yield { type: "a2ui", envelopes };
      }
    }

    buffer = scan.residual;
    // Track whether the residual is (part of) an a2ui fence so non-text
    // events between chunks know to hold their flush. Covers both a complete
    // unclosed opener ("```a2ui\n...") and a split opener prefix ("```a2").
    inFence = buffer.startsWith("```");
  }

  // Stream closed. If a fence was never closed, the residual is plain text —
  // never drop user-visible output on the floor.
  if (buffer) yield { type: "text", text: buffer };
}
