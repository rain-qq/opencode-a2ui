/**
 * A2UI basic catalog component implementations (React).
 *
 * Each one receives a NodeProps and renders DOM, resolving DynamicValues
 * through bindValue / bindInput.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DynamicValue, FunctionCall, ActionSpec } from "@a2ui/protocol";
import { isFunctionCall, isTemplateChildren, BUILTIN_FUNCTIONS } from "@a2ui/protocol";
import type { ChildList } from "@a2ui/protocol";
import type { NodeProps, NodeRenderer } from "../renderer.js";
import { bindInput, bindValue, ensureBoolean, ensureNumber, ensureString, writeBack } from "../bind.js";
import type { BindContext } from "../bind.js";
import { firstFailure } from "../checks.js";
import { sendAction } from "../transport.js";
import { MarkdownView } from "../Markdown.js";

/* --------------- Layout / Display --------------- */

const Text: NodeRenderer = ({ node, ctx }) => {
  const text = ensureString(bindValue(node.text as DynamicValue<string>, ctx));
  const variant = (node.variant as string) || "body";
  return (
    <div className={`a2-text ${variant}`}>
      <MarkdownView content={text} />
    </div>
  );
};

const Image: NodeRenderer = ({ node, ctx }) => {
  const url = ensureString(bindValue(node.url as DynamicValue<string>, ctx));
  const alt = ensureString(bindValue(node.alt as DynamicValue<string>, ctx));
  return <img className="a2-image" src={url} alt={alt} />;
};

const Icon: NodeRenderer = ({ node, ctx }) => {
  const name = ensureString(bindValue(node.name as DynamicValue<string>, ctx));
  return <span className="a2-icon" title={name}>◆</span>;
};

const Video: NodeRenderer = ({ node, ctx }) => {
  const url = ensureString(bindValue(node.url as DynamicValue<string>, ctx));
  return <video className="a2-image" src={url} controls />;
};

const AudioPlayer: NodeRenderer = ({ node, ctx }) => {
  const url = ensureString(bindValue(node.url as DynamicValue<string>, ctx));
  return <audio src={url} controls />;
};

const Row: NodeRenderer = ({ node, ctx, renderChildren }) => (
  <div className="a2-row">{renderChildren(node.children, ctx)}</div>
);

const Column: NodeRenderer = ({ node, ctx, renderChildren }) => (
  <div className="a2-column">{renderChildren(node.children, ctx)}</div>
);

const List: NodeRenderer = ({ node, ctx, renderChildren }) => (
  <div className="a2-list">{renderChildren(node.children, ctx)}</div>
);

const Card: NodeRenderer = ({ node, ctx, renderChild }) => (
  <div className="a2-card">
    {node.child ? renderChild(node.child as string, ctx) : null}
  </div>
);

const Divider: NodeRenderer = () => <div className="a2-divider" />;

const Tabs: NodeRenderer = ({ node, ctx, renderChildren }) => {
  const [active, setActive] = useState(0);
  const labels = (bindValue(node.tabLabels as DynamicValue<string[]>, ctx) as string[]) ?? [];
  const pages = renderChildren(node.children, ctx);
  return (
    <div>
      <div className="a2-tabs-bar">
        {pages.map((_p, i) => (
          <button
            key={i}
            className={`a2-tab ${i === active ? "active" : ""}`}
            onClick={() => setActive(i)}
          >
            {labels[i] ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div>{pages[active] ?? null}</div>
    </div>
  );
};

const Modal: NodeRenderer = ({ node, ctx, renderChild }) => {
  const open = ensureBoolean(bindValue(node.open as DynamicValue<boolean>, ctx));
  if (!open) return null;
  return (
    <div className="a2-modal-overlay">
      <div className="a2-modal-body">
        {node.child ? renderChild(node.child as string, ctx) : null}
      </div>
    </div>
  );
};

/* --------------- Interactive --------------- */

function performAction(
  action: ActionSpec | undefined,
  surfaceId: string,
  sourceComponentId: string,
  ctx: NodeProps["ctx"]
) {
  if (!action) return;

  // Local function call (e.g. openUrl)
  if ("functionCall" in action && action.functionCall) {
    const fc = action.functionCall as FunctionCall;
    const fn = BUILTIN_FUNCTIONS[fc.call];
    if (!fn) {
      // eslint-disable-next-line no-console
      console.warn("[a2ui] unknown client function:", fc.call);
      return;
    }
    const args: Record<string, unknown> = {};
    if (fc.args) {
      for (const [k, v] of Object.entries(fc.args)) {
        args[k] = bindValue(v as DynamicValue<unknown>, ctx);
      }
    }
    fn(args);
    return;
  }

  // Server event
  if ("event" in action && action.event) {
    const ev = action.event;
    const context: Record<string, unknown> = {};
    if (ev.context) {
      for (const [k, v] of Object.entries(ev.context)) {
        context[k] = bindValue(v as DynamicValue<unknown>, ctx);
      }
    }
    sendAction(surfaceId, ev.name, sourceComponentId, context);
  }
}

const Button: NodeRenderer = ({ node, ctx, renderChild }) => {
  const variant = (node.variant as string) || "default";
  const failure = firstFailure(
    node.checks as never,
    ctx.surface.dataModel,
    ctx.scopePath
  );
  const disabled = !!failure || node.enabled === false;

  return (
    <button
      className={`a2-button ${variant}`}
      disabled={disabled}
      title={failure}
      onClick={() =>
        performAction(node.action as ActionSpec, ctx.surface.surfaceId, node.id, ctx)
      }
    >
      {node.child ? renderChild(node.child as string, ctx) : (
        ensureString(bindValue(node.text as DynamicValue<string>, ctx)) || "Button"
      )}
    </button>
  );
};

const TextField: NodeRenderer = ({ node, ctx }) => {
  const { abs, value } = bindInput(node.value as DynamicValue<string>, ctx);
  const label = ensureString(bindValue(node.label as DynamicValue<string>, ctx));
  const placeholder = ensureString(bindValue(node.placeholder as DynamicValue<string>, ctx));
  const error = firstFailure(node.checks as never, ctx.surface.dataModel, ctx.scopePath);

  return (
    <div>
      {label ? <label className="a2-input-label">{label}</label> : null}
      <input
        className="a2-input"
        type="text"
        value={ensureString(value)}
        placeholder={placeholder}
        onChange={(e) => writeBack(ctx.surface.surfaceId, abs, e.target.value)}
      />
      {error ? <div className="a2-error">{error}</div> : null}
    </div>
  );
};

const CheckBox: NodeRenderer = ({ node, ctx }) => {
  const { abs, value } = bindInput(node.value as DynamicValue<boolean>, ctx);
  const label = ensureString(bindValue(node.label as DynamicValue<string>, ctx));
  return (
    <label className="a2-checkbox">
      <input
        type="checkbox"
        checked={ensureBoolean(value)}
        onChange={(e) => writeBack(ctx.surface.surfaceId, abs, e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
};

const DateTimeInput: NodeRenderer = ({ node, ctx }) => {
  const { abs, value } = bindInput(node.value as DynamicValue<string>, ctx);
  const label = ensureString(bindValue(node.label as DynamicValue<string>, ctx));
  return (
    <div>
      {label ? <label className="a2-input-label">{label}</label> : null}
      <input
        className="a2-input"
        type="datetime-local"
        value={ensureString(value)}
        onChange={(e) => writeBack(ctx.surface.surfaceId, abs, e.target.value)}
      />
    </div>
  );
};

const ChoicePicker: NodeRenderer = ({ node, ctx }) => {
  const { abs, value } = bindInput(node.value as DynamicValue<string>, ctx);
  const label = ensureString(bindValue(node.label as DynamicValue<string>, ctx));
  const options =
    (bindValue(node.options as DynamicValue<string[]>, ctx) as string[]) ?? [];

  return (
    <div>
      {label ? <label className="a2-input-label">{label}</label> : null}
      <select
        className="a2-select"
        value={ensureString(value)}
        onChange={(e) => writeBack(ctx.surface.surfaceId, abs, e.target.value)}
      >
        <option value="" disabled>
          Select…
        </option>
        {options.map((opt, i) => (
          <option key={i} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
};

const Slider: NodeRenderer = ({ node, ctx }) => {
  const { abs, value } = bindInput(node.value as DynamicValue<number>, ctx);
  const label = ensureString(bindValue(node.label as DynamicValue<string>, ctx));
  const min = ensureNumber(node.min, 0);
  const max = ensureNumber(node.max, 100);
  const step = ensureNumber(node.step, 1);
  return (
    <div>
      {label ? <label className="a2-input-label">{label}: {ensureNumber(value)}</label> : null}
      <input
        className="a2-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={ensureNumber(value, min)}
        onChange={(e) => writeBack(ctx.surface.surfaceId, abs, Number(e.target.value))}
      />
    </div>
  );
};

/* --------------- Process / dashboard helpers --------------- */

/**
 * StepList — left-side vertical timeline of process steps.
 *
 * The intended usage is the ChildList template form:
 *   { componentId: "step-item", children: { path: "/steps", componentId: "step-item" } }
 *
 * Each row in `/steps` is expected to be a string record with at least
 * `id`, `num`, `title`, and `status` keys (`pending` | `active` | `completed`).
 * `progress` (e.g. "2/5") is shown when present. Clicking a row triggers the
 * action with `{ event: { name, context: { stepId } } }` so the agent can
 * react to manual step selection.
 */
/**
 * 容错: agent 偶尔会把 ChildList 模板写成单元素数组
 *   [{ path: "/data/path", componentId: "template-id" }]
 * 协议要求的形态是裸对象。unwrap 后再用协议层的 isTemplateChildren 判定。
 */
const unwrapChildListTemplate = (children: ChildList | undefined): ChildList | undefined => {
  if (
    Array.isArray(children) &&
    children.length === 1 &&
    !Array.isArray(children[0]) &&
    children[0] !== null &&
    typeof children[0] === "object" &&
    typeof (children[0] as { path?: unknown }).path === "string" &&
    typeof (children[0] as { componentId?: unknown }).componentId === "string"
  ) {
    return children[0] as { path: string; componentId: string };
  }
  return children;
};

const StepList: NodeRenderer = ({ node, ctx, renderChildren }) => {
  const emptyHint = ensureString(bindValue(node.emptyHint as DynamicValue<string>, ctx));
  // 容错: agent 有时把 ChildList 模板包成 [{ path, componentId }] 单元素数组
  const normalizedChildren = unwrapChildListTemplate(node.children);
  const hasChildren = Array.isArray(normalizedChildren)
    ? normalizedChildren.length > 0
    : isTemplateChildren(normalizedChildren);

  if (!hasChildren) {
    return (
      <div className="a2-steplist-empty">{emptyHint || "No steps yet."}</div>
    );
  }

  return (
    <div className="a2-steplist-wrap">
      <div className="a2-steplist">
        <div className="a2-steplist-track" aria-hidden />
        {renderChildren(normalizedChildren, ctx)}
        {/* 每个 StepItem 通过自身 node.action 处理点击；StepList 不再持有 action。 */}
      </div>
    </div>
  );
};

/**
 * StepItem — one row inside StepList. Defined as a standalone node that the
 * template references by id. Renders num / title / progress / status pill,
 * plus an independent `selected` highlight. Clicking a row toggles the
 * `selected` flag locally (pure frontend interaction, no action/event).
 *
 * Path resolution fallback: LLM-generated templates sometimes write absolute
 * paths like `{path:"/steps/title"}` while the runtime expects a scope-relative
 * path `{path:"title"}`. We try absolute first, then fall back to the same
 * field name resolved against `scopePath`. The fallback is silent so the
 * canonical form keeps working unchanged.
 */
function bindStepItemField(
  v: DynamicValue<unknown> | undefined,
  ctx: BindContext,
  fallbackLeaf: string
): unknown {
  const direct = bindValue(v as DynamicValue<unknown>, ctx);
  if (direct !== undefined && direct !== null && direct !== "") return direct;
  // Try the same field by leaf name against the current scope item.
  if (ctx.scopePath) {
    const relRef = { path: fallbackLeaf };
    const viaScope = bindValue(relRef as DynamicValue<unknown>, ctx);
    if (viaScope !== undefined && viaScope !== null && viaScope !== "") return viaScope;
  }
  return direct;
}

const StepItem: NodeRenderer = ({ node, ctx }) => {
  const num = ensureString(bindStepItemField(node.num as DynamicValue<string>, ctx, "num"));
  const title = ensureString(bindStepItemField(node.title as DynamicValue<string>, ctx, "title"));
  const status = ensureString(bindStepItemField(node.status as DynamicValue<string>, ctx, "status"));
  const progress = ensureString(bindStepItemField(node.progress as DynamicValue<string>, ctx, "progress"));
  const selected = ensureBoolean(bindStepItemField(node.selected as DynamicValue<boolean>, ctx, "selected"));

  const statusKey: "completed" | "active" | "pending" =
    status === "completed" || status === "active" ? status : "pending";

  // Pure-frontend toggle: clicking a row flips its `selected` flag in the
  // surface data model. No action/event is dispatched to the agent. The
  // pointer is computed once: scopePath is e.g. "/steps/0", so the field
  // pointer is "/steps/0/selected". When clicked again, the value is inverted
  // locally without any server round-trip.
  const toggleSelected = () => {
    if (!ctx.scopePath) return;
    const pointer = ctx.scopePath + "/selected";
    writeBack(ctx.surface.surfaceId, pointer, !selected);
  };

  return (
    <div
      className={`a2-stepitem status-${statusKey} ${selected ? "selected" : ""}`}
      onClick={toggleSelected}
      role="button"
      tabIndex={0}
      aria-pressed={selected || undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSelected();
        }
      }}
    >
      <div className="a2-stepitem-marker" aria-hidden>
        {statusKey === "completed" ? (
          <span className="a2-stepitem-check">✓</span>
        ) : statusKey === "active" ? (
          <span className="a2-stepitem-dot" />
        ) : (
          <span className="a2-stepitem-num">{num}</span>
        )}
      </div>
      <div className="a2-stepitem-body">
        <div className="a2-stepitem-title">{title}</div>
        {progress ? <div className="a2-stepitem-progress">{progress}</div> : null}
      </div>
      <div className={`a2-stepitem-pill pill-${statusKey}`}>
        {statusKey === "completed" ? "已完成" : statusKey === "active" ? "进行中" : "等待中"}
      </div>
    </div>
  );
};

/**
 * StepProgress — right-side top strip: title + percent + progress bar.
 */
const StepProgress: NodeRenderer = ({ node, ctx }) => {
  const title = ensureString(bindValue(node.title as DynamicValue<string>, ctx));
  const progressLabel = ensureString(
    bindValue(node.progressLabel as DynamicValue<string>, ctx)
  );
  const rawPercent = bindValue(node.percent as DynamicValue<number>, ctx);
  const percent = Math.max(0, Math.min(100, ensureNumber(rawPercent, 0)));

  return (
    <div className="a2-stepprogress">
      <div className="a2-stepprogress-title">{title}</div>
      <div className="a2-stepprogress-right">
        {progressLabel ? (
          <span className="a2-stepprogress-label">{progressLabel}</span>
        ) : null}
        <span className="a2-stepprogress-percent">{percent}%</span>
        <div className="a2-stepprogress-bar" aria-hidden>
          <div className="a2-stepprogress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
};

/**
 * Unwrap a `{ rows/headers/items/values: [...] }` wrapper into the inner array.
 * LLM tool-schemas occasionally emit this form when a2ui expects a bare
 * array. If the input is already an array, return it as-is.
 */
function unwrapArrayField<T = unknown>(v: unknown): T[] | undefined {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const key of ["rows", "headers", "items", "values", "columns"]) {
      if (Array.isArray(o[key])) return o[key] as T[];
    }
  }
  return undefined;
}

/**
 * DataTable — column headers + rows of strings. Suitable for the
 * "middle product" artifact panel of an execution step.
 */
const DataTable: NodeRenderer = ({ node, ctx }) => {
  const emptyHint = ensureString(bindValue(node.emptyHint as DynamicValue<string>, ctx));
  const columnsBinding =
    (bindValue(node.columns as DynamicValue<string[]>, ctx) as unknown) ?? [];
  const columns =
    unwrapArrayField<string>(columnsBinding)?.map((c) => ensureString(c)) ?? [];

  const rawRows = (bindValue(node.rows as DynamicValue<string[]>, ctx) as unknown) ?? [];
  const unwrappedRows = unwrapArrayField<unknown>(rawRows);
  // Allow either string[][] (correct shape) or flat string[]; coerce gracefully.
  const rows: string[][] = Array.isArray(unwrappedRows)
    ? unwrappedRows.map((r) =>
        Array.isArray(r) ? (r as unknown[]).map((c) => ensureString(c)) : [ensureString(r)]
      )
    : [];

  if (columns.length === 0 && rows.length === 0) {
    // Differentiate "data source missing" (binding returned empty) from
    // "data source empty" (binding resolved to an empty array). Helps the
    // agent understand whether it forgot to send updateDataModel or simply
    // had no rows to show.
    const sourceConfigured =
      node.rows !== undefined ||
      node.columns !== undefined;
    const hint =
      emptyHint ||
      (sourceConfigured ? "暂无数据" : "未配置数据源(rows / columns 未绑定)");
    return <div className="a2-datatable-empty">{hint}</div>;
  }

  return (
    <div className="a2-datatable-wrap">
      <div className="a2-datatable">
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * CardFooter — bottom action bar for a card-like surface.
 *
 * Renders children horizontally. When the natural inline width exceeds the
 * container, items that overflow are collected into a "更多 ▾" dropdown menu
 * to the right. Overflow is computed from DOM measurements, so the menu
 * adapts to container width / children width changes (ResizeObserver).
 *
 * Each child keeps its original action semantics — clicking a button in the
 * dropdown still triggers its `event` / `functionCall`. The dropdown only
 * changes *where* it renders, not what it is.
 *
 * Typical usage as the bottom strip of a console card:
 *   Card → Column(StepProgress, Row(StepList, DataTable), CardFooter(buttons))
 */
const CardFooter: NodeRenderer = ({ node, ctx, renderChildren }) => {
  const childrenArray = Array.isArray(node.children)
    ? (node.children as string[])
    : [];
  const hasChildren =
    childrenArray.length > 0 ||
    (node.children && !Array.isArray(node.children) && typeof node.children === "object");

  const [overflowCount, setOverflowCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Render all children up front, then measure which ones overflow.
  // We render an extra hidden "ghost" clone of each item with width
  // measurement to know its natural width without depending on layout.
  const rendered = renderChildren(node.children, ctx);
  const items: React.ReactNode[] = Array.isArray(rendered) ? rendered : [rendered];

  // Measure: for each item, render it into a hidden inline-block span and
  // read offsetWidth. Sum until we exceed the available width.
  //
  // We use useLayoutEffect so the dropdown updates synchronously after layout
  // — preventing a flash where overflow items appear inline before being
  // moved to the menu.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);

  const computeOverflow = () => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    const itemEls = measure.children;
    if (itemEls.length === 0) {
      setOverflowCount(0);
      return;
    }
    const available = container.clientWidth;
    // Reserve 40px for the "更多" trigger when overflow is likely.
    const reserve = 56;
    let used = 0;
    let count = 0;
    for (let i = 0; i < itemEls.length; i++) {
      const w = (itemEls[i] as HTMLElement).offsetWidth + 6; // 6 = gap
      if (used + w + reserve > available) {
        count = itemEls.length - i;
        break;
      }
      used += w;
    }
    setOverflowCount(count);
  };

  useLayoutEffect(() => {
    computeOverflow();
    // 依赖 items.length / surfaceId：只在子项数量变化时同步重算。
    // label 文本变化（length 不变）由下面 ResizeObserver 监听 ghost 行宽度来补偿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, ctx.surface.surfaceId]);

  useEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => computeOverflow());
    ro.observe(container);
    // ghost 行是 nowrap + inline-block 子项，其宽度 = 所有子项自然宽度之和。
    // 任意 button label 变宽都会撑大 measure，触发重算——补上 useLayoutEffect
    // 漏掉的"内容变化但数量不变"场景（i18n 切换、text:{path} 绑定值刷新等）。
    if (measure) ro.observe(measure);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  if (!hasChildren) return null;

  const visibleItems = overflowCount > 0 ? items.slice(0, items.length - overflowCount) : items;
  const overflowItems =
    overflowCount > 0 ? items.slice(items.length - overflowCount) : [];

  return (
    <div className="a2-cardfooter" ref={containerRef}>
      {/* Hidden measurement row: clones of every child, inline-block so
          offsetWidth reflects natural width without affecting layout. */}
      <div
        ref={measureRef}
        aria-hidden
        style={{
          position: "absolute",
          visibility: "hidden",
          pointerEvents: "none",
          whiteSpace: "nowrap",
          left: 0,
          top: 0,
        }}
      >
        {items.map((it, i) => (
          <span
            key={i}
            style={{ display: "inline-block", marginRight: 6 }}
          >
            {it}
          </span>
        ))}
      </div>

      <div className="a2-cardfooter-row">
        {visibleItems.map((it, i) => (
          <div key={i} className="a2-cardfooter-item">
            {it}
          </div>
        ))}
      </div>

      {overflowItems.length > 0 && (
        <div className="a2-cardfooter-more" ref={menuRef}>
          <button
            className="a2-button"
            onClick={() => setMenuOpen((v) => !v)}
            type="button"
          >
            <span>更多</span>
            <span className={`a2-cardfooter-caret ${menuOpen ? "open" : ""}`}>▾</span>
          </button>
          {menuOpen && (
            <div className="a2-cardfooter-menu" role="menu">
              {overflowItems.map((it, i) => (
                <div
                  key={i}
                  className="a2-cardfooter-menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  {it}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* --------------- Registry --------------- */

export const COMPONENTS: Record<string, NodeRenderer> = {
  Text,
  Image,
  Icon,
  Video,
  AudioPlayer,
  Row,
  Column,
  List,
  Card,
  Tabs,
  Divider,
  Modal,
  Button,
  TextField,
  CheckBox,
  DateTimeInput,
  ChoicePicker,
  Slider,
  // Process / dashboard helpers
  StepList,
  StepItem,
  StepProgress,
  DataTable,
  CardFooter,
};

// Sanity export to keep type checker happy when imports add side-effects only.
export { isFunctionCall };
