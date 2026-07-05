/**
 * Client-side A2UI state. One store per app holds all surfaces and a unified
 * conversation timeline.
 */

import { create } from "zustand";
import type {
  A2UIEnvelope,
  ComponentId,
  ComponentNode,
  SurfaceId,
  ThemeProps,
} from "@a2ui/protocol";
import { setByPointer } from "@a2ui/protocol";

export interface Surface {
  surfaceId: SurfaceId;
  catalogId: string;
  theme?: ThemeProps;
  sendDataModel: boolean;
  components: Record<ComponentId, ComponentNode>;
  dataModel: unknown;
}

export type ConversationItem =
  | { id: string; type: "user_message"; text: string; ts: number }
  | { id: string; type: "assistant_text"; text: string; ts: number }
  | { id: string; type: "system_message"; text: string; ts: number }
  | { id: string; type: "trace"; message: string; ts: number }
  | { id: string; type: "tool_call"; callId: string; name: string; args: unknown; ts: number }
  | { id: string; type: "tool_result"; callId: string; name: string; result?: unknown; error?: string; ts: number }
  | { id: string; type: "error"; code: string; message: string; ts: number }
  | { id: string; type: "surface"; surfaceId: SurfaceId; ts: number };

/** Input shape for pushConversation: ConversationItem minus id/ts, distributed
 *  across the union so per-member fields (text/message/callId/code/surfaceId)
 *  survive. A plain Omit<Union> collapses to the shared keys and rejects them. */
export type ConversationItemInput = {
  [K in ConversationItem["type"]]: Omit<
    Extract<ConversationItem, { type: K }>,
    "id" | "ts"
  >;
}[ConversationItem["type"]];

interface A2UIState {
  sessionId: string;
  busy: boolean;
  surfaces: Record<SurfaceId, Surface>;
  surfaceOrder: SurfaceId[];
  conversation: ConversationItem[];

  setBusy(b: boolean): void;
  pushConversation(item: ConversationItemInput): void;
  appendAgentText(text: string): void;
  ensureSurfaceConversationItem(surfaceId: SurfaceId): void;
  applyEnvelope(env: A2UIEnvelope): void;
  writeData(surfaceId: SurfaceId, pointer: string, value: unknown): void;
  reset(): void;
}

function makeSessionId() {
  return "sess_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function stamp(item: ConversationItemInput): ConversationItem {
  return { ...item, id: makeId(), ts: Date.now() } as ConversationItem;
}

/**
 * Some agent runtimes emit repeated fields as `{item: [...]}` (proto-style
 * wrapper) instead of a plain array. Recursively normalize any object of the
 * exact shape `{item: [...]}` (a single "item" key holding an array) back to
 * the underlying array so downstream code can just `.map` over it. Leaves
 * `{path}` / `{path, componentId}` / other objects untouched.
 */
function unwrapItems(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapItems);
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "item" && Array.isArray(obj.item)) {
      return (obj.item as unknown[]).map(unwrapItems);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = unwrapItems(obj[k]);
    return out;
  }
  return v;
}

export const useA2UI = create<A2UIState>((set, get) => ({
  sessionId: makeSessionId(),
  busy: false,
  surfaces: {},
  surfaceOrder: [],
  conversation: [],

  setBusy: (b) => set({ busy: b }),
  pushConversation: (item) =>
    set((s) => ({ conversation: [...s.conversation, stamp(item)] })),
  appendAgentText: (text) =>
    set((s) => {
      // Streaming text arrives as many small deltas; append to the last
      // assistant_text bubble so a single answer stays one bubble. A non-text
      // event in between (tool_call / a2ui / surface) closes the bubble.
      const last = s.conversation[s.conversation.length - 1];
      if (last && last.type === "assistant_text") {
        const next = [...s.conversation];
        next[next.length - 1] = { ...last, text: last.text + text };
        return { conversation: next };
      }
      return {
        conversation: [...s.conversation, stamp({ type: "assistant_text", text })],
      };
    }),

  ensureSurfaceConversationItem: (surfaceId) =>
    set((s) => {
      const exists = s.conversation.some(
        (item) => item.type === "surface" && item.surfaceId === surfaceId
      );
      if (exists) return s;
      return {
        conversation: [...s.conversation, stamp({ type: "surface", surfaceId })],
      };
    }),

  applyEnvelope: (env) => {
    if (env.createSurface) {
      const c = env.createSurface;
      set((s) => {
        const nextSurfaces = s.surfaces[c.surfaceId]
          ? s.surfaces
          : {
              ...s.surfaces,
              [c.surfaceId]: {
                surfaceId: c.surfaceId,
                catalogId: c.catalogId,
                theme: c.theme,
                sendDataModel: !!c.sendDataModel,
                components: {},
                dataModel: {},
              },
            };

        const hasSurfaceItem = s.conversation.some(
          (item) => item.type === "surface" && item.surfaceId === c.surfaceId
        );

        return {
          surfaces: nextSurfaces,
          surfaceOrder: s.surfaceOrder.includes(c.surfaceId)
            ? s.surfaceOrder
            : [...s.surfaceOrder, c.surfaceId],
          conversation: hasSurfaceItem
            ? s.conversation
            : [...s.conversation, stamp({ type: "surface", surfaceId: c.surfaceId })],
        };
      });
      return;
    }

    if (env.updateComponents) {
      const u = env.updateComponents;
      const raw = unwrapItems(u.components) as unknown;
      const list: ComponentNode[] = Array.isArray(raw)
        ? (raw as ComponentNode[])
        : [];
      set((s) => {
        const cur = s.surfaces[u.surfaceId];
        if (!cur) return s;
        const next = { ...cur.components };
        for (const node of list) {
          if (node && typeof node === "object" && typeof node.id === "string") {
            next[node.id] = node;
          }
        }
        return {
          surfaces: { ...s.surfaces, [u.surfaceId]: { ...cur, components: next } },
        };
      });
      return;
    }

    if (env.updateDataModel) {
      const u = env.updateDataModel;
      // Accept `{dataModel: {...}}` as an alias for a full-root replacement,
      // in addition to the spec's `{path, value}`.
      const hasValue = "value" in u;
      const rawValue = hasValue
        ? u.value
        : (u as { dataModel?: unknown }).dataModel;
      const value = unwrapItems(rawValue);
      set((s) => {
        const cur = s.surfaces[u.surfaceId];
        if (!cur) return s;
        let nextModel: unknown;
        if (!u.path || u.path === "/" || u.path === "") {
          nextModel = value;
        } else {
          nextModel = setByPointer(cur.dataModel ?? {}, u.path, value);
        }
        return {
          surfaces: { ...s.surfaces, [u.surfaceId]: { ...cur, dataModel: nextModel } },
        };
      });
      return;
    }

    if (env.deleteSurface) {
      const d = env.deleteSurface;
      set((s) => {
        const { [d.surfaceId]: _drop, ...rest } = s.surfaces;
        return {
          surfaces: rest,
          surfaceOrder: s.surfaceOrder.filter((id) => id !== d.surfaceId),
          conversation: s.conversation.filter(
            (item) => !(item.type === "surface" && item.surfaceId === d.surfaceId)
          ),
        };
      });
    }
  },

  writeData: (surfaceId, pointer, value) => {
    set((s) => {
      const cur = s.surfaces[surfaceId];
      if (!cur) return s;
      const next = setByPointer(cur.dataModel ?? {}, pointer, value);
      return {
        surfaces: { ...s.surfaces, [surfaceId]: { ...cur, dataModel: next } },
      };
    });
    if (typeof window !== "undefined") {
      // eslint-disable-next-line no-console
      console.debug("[a2ui:write]", surfaceId, pointer, value);
    }
  },

  reset: () =>
    set({
      sessionId: makeSessionId(),
      surfaces: {},
      surfaceOrder: [],
      conversation: [],
      busy: false,
    }),
}));

/** Snapshot all surface data models (for sendDataModel-enabled actions). */
export function snapshotSurfaceDataModels(): Record<SurfaceId, unknown> {
  const state = useA2UI.getState();
  const out: Record<SurfaceId, unknown> = {};
  for (const id of state.surfaceOrder) {
    const surf = state.surfaces[id];
    if (surf?.sendDataModel) out[id] = surf.dataModel;
  }
  return out;
}
