/**
 * A2UI basic catalog component implementations (React).
 *
 * Each one receives a NodeProps and renders DOM, resolving DynamicValues
 * through bindValue / bindInput.
 */

import React, { useState } from "react";
import type { DynamicValue, FunctionCall, ActionSpec } from "@a2ui/protocol";
import { isFunctionCall, BUILTIN_FUNCTIONS } from "@a2ui/protocol";
import type { NodeProps, NodeRenderer } from "../renderer.js";
import { bindInput, bindValue, ensureBoolean, ensureNumber, ensureString, writeBack } from "../bind.js";
import { firstFailure } from "../checks.js";
import { sendAction } from "../transport.js";

/* --------------- Layout / Display --------------- */

const Text: NodeRenderer = ({ node, ctx }) => {
  const text = ensureString(bindValue(node.text as DynamicValue<string>, ctx));
  const variant = (node.variant as string) || "body";
  return <div className={`a2-text ${variant}`}>{text}</div>;
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
};

// Sanity export to keep type checker happy when imports add side-effects only.
export { isFunctionCall };
