/**
 * Recursive renderer. Walks the adjacency list from "root" and creates React
 * elements via the component registry. Honors progressive rendering by
 * falling back to a placeholder when a referenced id is not yet present.
 */

import React from "react";
import { isTemplateChildren } from "@a2ui/protocol";
import type { ChildList, ComponentNode } from "@a2ui/protocol";
import { COMPONENTS } from "./components/index.js";
import type { Surface } from "./store.js";
import { joinPointer } from "@a2ui/protocol";

export interface RenderContext {
  surface: Surface;
  scopePath?: string;
  /** Visited ids in the current render path, used to break accidental cycles. */
  trail: Set<string>;
}

export function renderNode(id: string, ctx: RenderContext): React.ReactNode {
  if (ctx.trail.has(id)) {
    return (
      <div key={id} className="a2-placeholder">cyclic reference: {id}</div>
    );
  }
  const node = ctx.surface.components[id];
  if (!node) {
    return (
      <div key={id} className="a2-placeholder">…loading "{id}"</div>
    );
  }

  const Comp = COMPONENTS[node.component];
  if (!Comp) {
    return (
      <div key={id} className="a2-placeholder">
        unsupported component: {node.component}
      </div>
    );
  }

  const childTrail = new Set(ctx.trail);
  childTrail.add(id);

  return (
    <Comp
      key={id}
      node={node}
      ctx={{ ...ctx, trail: childTrail }}
      renderChild={(childId, childCtx) => renderNode(childId, childCtx)}
      renderChildren={(children, childCtx) =>
        renderChildList(children, childCtx)
      }
    />
  );
}

export function renderChildList(
  children: ChildList | undefined,
  ctx: RenderContext
): React.ReactNode[] {
  if (!children) return [];

  // Static array form.
  if (Array.isArray(children)) {
    return children.map((cid) => renderNode(cid, ctx));
  }

  // Template form: { path, componentId } — iterate over the array at `path`
  // and render the template per item, with a scope rooted at that item.
  if (isTemplateChildren(children)) {
    const { path, componentId } = children;
    const absRoot = path.startsWith("/") ? path : "/" + path;
    const arr = getRaw(ctx.surface.dataModel, absRoot);
    if (!Array.isArray(arr)) return [];

    return arr.map((item, i) => {
      const scopePath = joinPointer(absRoot, i);
      // Key by the row's own `id` when present, so components keyed to a row
      // keep their local state (e.g. StepItem's `selected`) when the agent
      // inserts or removes rows mid-array. Falls back to the index.
      const rowId =
        item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          ? ((item as Record<string, unknown>).id as string)
          : i;
      const key = `${componentId}:${rowId}`;
      return (
        <React.Fragment key={key}>
          {renderNode(componentId, { ...ctx, scopePath })}
        </React.Fragment>
      );
    });
  }

  return [];
}

function getRaw(obj: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return obj;
  const tokens = pointer.startsWith("/") ? pointer.slice(1).split("/") : pointer.split("/");
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(t)];
    else if (typeof cur === "object")
      cur = (cur as Record<string, unknown>)[t.replace(/~1/g, "/").replace(/~0/g, "~")];
    else return undefined;
  }
  return cur;
}

/**
 * Component implementation signature shared by all components.
 */
export interface NodeRenderer {
  (props: NodeProps): React.ReactElement | null;
}
export interface NodeProps {
  node: ComponentNode;
  ctx: RenderContext;
  renderChild: (id: string, ctx: RenderContext) => React.ReactNode;
  renderChildren: (children: ChildList | undefined, ctx: RenderContext) => React.ReactNode[];
}
