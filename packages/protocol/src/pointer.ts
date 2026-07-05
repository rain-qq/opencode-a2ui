/**
 * Minimal RFC 6901 JSON Pointer implementation, with helpers for
 * the A2UI extension where pointers used inside ChildList templates
 * may be RELATIVE (no leading "/") and resolve against an iteration scope.
 */

function unescape(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function escape(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  const isAbsolute = pointer.startsWith("/");
  const body = isAbsolute ? pointer.slice(1) : pointer;
  return body.split("/").map(unescape);
}

export function isAbsolutePointer(pointer: string): boolean {
  return pointer.startsWith("/");
}

export function getByPointer(root: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[tok];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Immutable set: returns a new structure with the value written at `pointer`.
 * Creates intermediate objects/arrays as needed (numeric tokens => arrays).
 * If `value` is undefined, deletes the key.
 */
export function setByPointer(root: unknown, pointer: string, value: unknown): unknown {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) {
    return value;
  }

  const clone = (v: unknown, nextToken: string): unknown => {
    if (Array.isArray(v)) return [...v];
    if (v && typeof v === "object") return { ...(v as Record<string, unknown>) };
    return /^\d+$/.test(nextToken) ? [] : {};
  };

  const rootClone = clone(root, tokens[0]);
  let cur = rootClone as Record<string, unknown> | unknown[];

  for (let i = 0; i < tokens.length - 1; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    const child = Array.isArray(cur)
      ? cur[Number(tok)]
      : (cur as Record<string, unknown>)[tok];
    const newChild = clone(child, next);
    if (Array.isArray(cur)) {
      cur[Number(tok)] = newChild;
    } else {
      (cur as Record<string, unknown>)[tok] = newChild;
    }
    cur = newChild as Record<string, unknown> | unknown[];
  }

  const last = tokens[tokens.length - 1];
  if (Array.isArray(cur)) {
    if (value === undefined) {
      cur.splice(Number(last), 1);
    } else {
      cur[Number(last)] = value;
    }
  } else {
    if (value === undefined) {
      delete (cur as Record<string, unknown>)[last];
    } else {
      (cur as Record<string, unknown>)[last] = value;
    }
  }

  return rootClone;
}

/** Build an absolute pointer by appending tokens. */
export function joinPointer(base: string, ...tokens: (string | number)[]): string {
  let p = base;
  if (!p.startsWith("/") && p !== "") p = "/" + p;
  for (const t of tokens) p += "/" + escape(String(t));
  return p === "" ? "/" : p;
}
