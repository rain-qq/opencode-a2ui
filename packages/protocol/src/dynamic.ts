/**
 * DynamicValue evaluation: literal | PathRef | FunctionCall.
 *
 * Supports a context object that carries the current data model and a "scope"
 * for relative-path resolution inside ChildList templates.
 */

import { BUILTIN_FUNCTIONS } from "./functions.js";
import { getByPointer, isAbsolutePointer } from "./pointer.js";
import {
  DynamicValue,
  FunctionCall,
  PathRef,
  isFunctionCall,
  isPathRef,
} from "./types.js";

export interface ResolveContext {
  dataModel: unknown;
  /** Absolute pointer prefix for the current iteration item, if any. */
  scopePath?: string;
  /** Optional extra functions on top of BUILTIN_FUNCTIONS. */
  functions?: Record<string, (args: Record<string, unknown>) => unknown>;
}

function lookupFn(
  name: string,
  ctx: ResolveContext
): ((args: Record<string, unknown>) => unknown) | undefined {
  return ctx.functions?.[name] ?? BUILTIN_FUNCTIONS[name];
}

function resolvePath(ref: PathRef, ctx: ResolveContext): unknown {
  const p = ref.path;
  if (isAbsolutePointer(p)) {
    return getByPointer(ctx.dataModel, p);
  }
  // Relative path: resolve against scopePath if present, else against the root.
  if (!ctx.scopePath) {
    return getByPointer(ctx.dataModel, "/" + p);
  }
  const full = ctx.scopePath + (p ? "/" + p : "");
  return getByPointer(ctx.dataModel, full);
}

/**
 * Special-case the `formatString` template engine so it can recurse into the
 * dynamic resolver and produce a final string.
 *
 *   "Hello, ${/user/firstName}!"
 *   "${formatDate(value:${/today}, format:'yyyy-MM-dd')}"
 */
function evalFormatString(template: string, ctx: ResolveContext): string {
  // Replace ${...} non-greedily, handling balanced braces inside.
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "\\" && template[i + 1] === "$" && template[i + 2] === "{") {
      out += "${";
      i += 3;
      continue;
    }
    if (template[i] === "$" && template[i + 1] === "{") {
      // find matching close
      let depth = 1;
      let j = i + 2;
      let inStr: string | null = null;
      while (j < template.length && depth > 0) {
        const c = template[j];
        if (inStr) {
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === inStr) inStr = null;
        } else {
          if (c === "'" || c === '"') inStr = c;
          else if (c === "{") depth++;
          else if (c === "}") depth--;
        }
        if (depth === 0) break;
        j++;
      }
      const expr = template.slice(i + 2, j);
      out += String(evalExpr(expr, ctx) ?? "");
      i = j + 1;
      continue;
    }
    out += template[i++];
  }
  return out;
}

/**
 * Mini-expression parser used inside ${...}.
 * Supports:
 *   - JSON Pointer paths: /a/b or rel/b
 *   - Quoted strings: 'foo' or "foo"
 *   - Numbers and booleans
 *   - Function calls: fn(arg:expr, arg2:expr)
 *   - Nested ${...} (delegated to evalFormatString)
 */
function evalExpr(expr: string, ctx: ResolveContext): unknown {
  const s = expr.trim();

  // Function call: name(args...)
  const fnMatch = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(s);
  if (fnMatch) {
    const name = fnMatch[1];
    const argsBlob = fnMatch[2];
    const args = parseArgs(argsBlob, ctx);
    const fn = lookupFn(name, ctx);
    if (!fn) return "";
    // formatString gets special treatment to re-enter the template engine.
    if (name === "formatString" && typeof args.value === "string") {
      return evalFormatString(args.value, ctx);
    }
    return fn(args);
  }

  // String literal
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }

  // Number / boolean
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;

  // Nested template
  if (s.startsWith("${") && s.endsWith("}")) {
    return evalExpr(s.slice(2, -1), ctx);
  }

  // Default: treat as a JSON pointer path (absolute or relative).
  return resolvePath({ path: s }, ctx);
}

function parseArgs(blob: string, ctx: ResolveContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const parts = splitTopLevel(blob, ",");
  for (const part of parts) {
    const colon = findTopLevel(part, ":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    const val = part.slice(colon + 1).trim();
    result[key] = evalExpr(val, ctx);
  }
  return result;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
    } else {
      if (c === "'" || c === '"') inStr = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (depth === 0 && c === sep) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function findTopLevel(s: string, ch: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
    } else {
      if (c === "'" || c === '"') inStr = c;
      else if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
      else if (depth === 0 && c === ch) return i;
    }
  }
  return -1;
}

/** Resolve a DynamicValue. */
export function resolveDynamic<T>(value: DynamicValue<T>, ctx: ResolveContext): unknown {
  if (isPathRef(value)) {
    return resolvePath(value, ctx);
  }
  if (isFunctionCall(value)) {
    return resolveFunctionCall(value, ctx);
  }
  return value;
}

export function resolveFunctionCall(fc: FunctionCall, ctx: ResolveContext): unknown {
  const fn = lookupFn(fc.call, ctx);
  if (!fn) return undefined;

  const args: Record<string, unknown> = {};
  if (fc.args) {
    for (const [k, v] of Object.entries(fc.args)) {
      args[k] = resolveDynamic(v as DynamicValue<unknown>, ctx);
    }
  }

  // formatString needs the template re-entered through the expression engine.
  if (fc.call === "formatString" && typeof args.value === "string") {
    return evalFormatString(args.value, ctx);
  }

  return fn(args);
}

export { evalFormatString };
