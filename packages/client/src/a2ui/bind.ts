/**
 * Helpers wired to the live store: render-time data binding and write-back.
 */

import type { DynamicValue, PathRef } from "@a2ui/protocol";
import { isPathRef, joinPointer, resolveDynamic } from "@a2ui/protocol";
import type { Surface } from "./store.js";
import { useA2UI } from "./store.js";

export interface BindContext {
  surface: Surface;
  scopePath?: string;
}

export function bindValue<T>(value: DynamicValue<T>, ctx: BindContext): unknown {
  return resolveDynamic(value, {
    dataModel: ctx.surface.dataModel,
    scopePath: ctx.scopePath,
  });
}

/**
 * For input components: value is usually a PathRef. Returns the absolute
 * pointer (scope-aware) that onChange should write back to, plus the
 * currently bound value.
 */
export function bindInput<T>(
  value: DynamicValue<T> | undefined,
  ctx: BindContext
): { abs?: string; value: unknown } {
  if (value === undefined) return { value: undefined };
  if (isPathRef(value)) {
    const abs = absolutePath(value, ctx);
    return { abs, value: bindValue(value, ctx) };
  }
  return { value: bindValue(value, ctx) };
}

function absolutePath(ref: PathRef, ctx: BindContext): string {
  if (ref.path.startsWith("/")) return ref.path;
  // Relative -> resolve against scopePath (or root).
  return ctx.scopePath ? joinPointer(ctx.scopePath, ...ref.path.split("/")) : "/" + ref.path;
}

export function writeBack(surfaceId: string, abs: string | undefined, value: unknown) {
  if (!abs) return;
  useA2UI.getState().writeData(surfaceId, abs, value);
}

export function ensureString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

export function ensureNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function ensureBoolean(v: unknown): boolean {
  return Boolean(v);
}
