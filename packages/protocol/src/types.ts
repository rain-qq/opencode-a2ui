/**
 * A2UI v0.9.1 protocol types.
 * Spec: https://a2ui.org/specification/v0.9.1-a2ui/
 */

export const A2UI_VERSION = "v0.9.1" as const;
export const BASIC_CATALOG_ID =
  "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json";

export type ComponentId = string;
export type SurfaceId = string;

/** A JSON Pointer (RFC 6901) reference. Inside ChildList templates, may be relative (no leading "/"). */
export interface PathRef {
  path: string;
}

/** A function invocation that resolves at evaluation time. */
export interface FunctionCall {
  call: string;
  args?: Record<string, DynamicValue<unknown>>;
}

/** DynamicValue: a literal of type T, or a path ref, or a function call. */
export type DynamicValue<T> = T | PathRef | FunctionCall;
export type DynamicString = DynamicValue<string>;
export type DynamicNumber = DynamicValue<number>;
export type DynamicBoolean = DynamicValue<boolean>;
export type DynamicStringList = DynamicValue<string[]>;

/** ChildList: either a static array of component ids, or a template binding for iteration. */
export type ChildList = ComponentId[] | { path: string; componentId: ComponentId };

/** Theme / surface properties (basic catalog). */
export interface ThemeProps {
  primaryColor?: string;
  iconUrl?: string;
  agentDisplayName?: string;
}

/** A check (validation rule) attached to inputs/buttons. */
export interface CheckSpec {
  call: string;
  args?: Record<string, DynamicValue<unknown>>;
  message?: string;
}

/** ServerEvent action: dispatched to the agent server. */
export interface ServerEventAction {
  event: {
    name: string;
    context?: Record<string, DynamicValue<unknown>>;
  };
}

/** Local (client-side) function action. */
export interface LocalFunctionAction {
  functionCall: FunctionCall;
}

export type ActionSpec = ServerEventAction | LocalFunctionAction;

/** A generic component node in the adjacency list. */
export interface ComponentNode {
  id: ComponentId;
  component: string;
  /** child / children references */
  child?: ComponentId;
  children?: ChildList;
  /** any other component-specific props */
  [key: string]: unknown;
}

/* ---------- Server -> Client envelope messages ---------- */

export interface CreateSurfaceMsg {
  surfaceId: SurfaceId;
  catalogId: string;
  theme?: ThemeProps;
  sendDataModel?: boolean;
}

export interface UpdateComponentsMsg {
  surfaceId: SurfaceId;
  components: ComponentNode[];
}

export interface UpdateDataModelMsg {
  surfaceId: SurfaceId;
  /** Omitted or "/" replaces the entire model. */
  path?: string;
  /** Omitted value removes the key. */
  value?: unknown;
}

export interface DeleteSurfaceMsg {
  surfaceId: SurfaceId;
}

export interface A2UIEnvelope {
  version: string;
  createSurface?: CreateSurfaceMsg;
  updateComponents?: UpdateComponentsMsg;
  updateDataModel?: UpdateDataModelMsg;
  deleteSurface?: DeleteSurfaceMsg;
}

/* ---------- Client -> Server action payload ---------- */

export interface ActionPayload {
  name: string;
  surfaceId: SurfaceId;
  sourceComponentId?: ComponentId;
  timestamp: string;
  context?: Record<string, unknown>;
  /** Attached when the surface was created with sendDataModel: true. */
  a2uiClientDataModel?: {
    surfaces: Record<SurfaceId, unknown>;
  };
}

/* ---------- Helpers ---------- */

export function isPathRef(v: unknown): v is PathRef {
  return !!v && typeof v === "object" && typeof (v as PathRef).path === "string";
}

export function isFunctionCall(v: unknown): v is FunctionCall {
  return !!v && typeof v === "object" && typeof (v as FunctionCall).call === "string";
}

export function isTemplateChildren(
  v: ChildList | undefined
): v is { path: string; componentId: ComponentId } {
  return (
    !!v &&
    !Array.isArray(v) &&
    typeof (v as { path: string }).path === "string" &&
    typeof (v as { componentId: string }).componentId === "string"
  );
}
