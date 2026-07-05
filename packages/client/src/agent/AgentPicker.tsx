/**
 * Three trigger buttons + a shared dropdown for picking skills / MCPs /
 * subagents. Multi-select within each kind. Selection lives on the global
 * a2ui store; this component is a thin renderer.
 *
 * Layout (inside the chat input field, left side):
 *   [Agents (2)]  [Skills (1)]  [MCPs (0)]   (chips with active count)
 *
 * The picker is rendered inside `.chat-input-field` alongside the bare
 * `<input>`; clicking a chip opens a dropdown that pops above the field.
 */

import React, { useEffect, useRef, useState } from "react";
import { useA2UI, type RegistryEntry } from "../a2ui/store.js";

type Kind = "agents" | "skills" | "mcps";

const KIND_LABELS: Record<Kind, string> = {
  agents: "Agents",
  skills: "Skills",
  mcps: "MCPs",
};

const KIND_ICONS: Record<Kind, string> = {
  agents: "🤖",
  skills: "✨",
  mcps: "🔌",
};

export function AgentPicker() {
  const registry = useA2UI((s) => s.registry);
  const registryLoading = useA2UI((s) => s.registryLoading);
  const registryError = useA2UI((s) => s.registryError);
  const selection = useA2UI((s) => s.selection);
  const fetchRegistry = useA2UI((s) => s.fetchRegistry);
  const toggleSelection = useA2UI((s) => s.toggleSelection);
  const clearSelection = useA2UI((s) => s.clearSelection);

  const [openKind, setOpenKind] = useState<Kind | null>(null);

  // Fetch the registry once on mount.
  useEffect(() => {
    if (!registry && !registryLoading && !registryError) {
      fetchRegistry();
    }
  }, [registry, registryLoading, registryError, fetchRegistry]);

  // Close the dropdown on outside click + Esc.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openKind) return;
    function onDoc(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpenKind(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenKind(null);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [openKind]);

  const totalSelected =
    selection.agents.length + selection.skills.length + selection.mcps.length;

  const kinds: Kind[] = ["agents", "skills", "mcps"];

  return (
    <div className="agent-picker" ref={containerRef}>
      {kinds.map((kind) => {
        const count = selection[kind].length;
        const active = openKind === kind;
        return (
          <div key={kind} className="agent-picker-cell">
            <button
              type="button"
              className={"agent-trigger" + (active ? " active" : "") + (count > 0 ? " has-selection" : "")}
              onClick={() => setOpenKind(active ? null : kind)}
              aria-expanded={active}
              aria-haspopup="listbox"
              disabled={!registry}
            >
              <span className="agent-trigger-icon">{KIND_ICONS[kind]}</span>
              <span className="agent-trigger-label">{KIND_LABELS[kind]}</span>
              {count > 0 && <span className="agent-trigger-badge">{count}</span>}
            </button>

            {active && registry && (
              <Dropdown
                kind={kind}
                entries={registry[kind]}
                selected={selection[kind]}
                onToggle={(id) => toggleSelection(kind, id)}
              />
            )}
          </div>
        );
      })}

      {registryError && (
        <span className="agent-picker-error" title={registryError}>
          注册表加载失败
          <button
            type="button"
            className="agent-picker-retry"
            onClick={fetchRegistry}
            disabled={registryLoading}
            title="重新加载注册表"
          >
            重试
          </button>
        </span>
      )}

      {totalSelected > 0 && (
        <button
          type="button"
          className="agent-clear"
          onClick={clearSelection}
          title="清除全部已选"
        >
          清空
        </button>
      )}
    </div>
  );
}

interface DropdownProps {
  kind: Kind;
  entries: RegistryEntry[];
  selected: string[];
  onToggle: (id: string) => void;
}

function Dropdown({ kind, entries, selected, onToggle }: DropdownProps) {
  const selectedSet = new Set(selected);
  return (
    <div className="agent-dropdown" role="listbox" aria-multiselectable>
      <div className="agent-dropdown-head">
        <span>{KIND_LABELS[kind]}（多选）</span>
        <span className="agent-dropdown-count">{selected.length}/{entries.length}</span>
      </div>
      <div className="agent-dropdown-list">
        {entries.length === 0 && (
          <div className="agent-dropdown-empty">无可选项</div>
        )}
        {entries.map((e) => {
          const checked = selectedSet.has(e.id);
          return (
            <label
              key={e.id}
              className={"agent-dropdown-item" + (checked ? " checked" : "")}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(e.id)}
              />
              <span className="agent-dropdown-item-main">
                <span className="agent-dropdown-item-label">{e.label}</span>
                <span className="agent-dropdown-item-desc">{e.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}