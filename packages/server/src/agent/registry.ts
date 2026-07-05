/**
 * Static registry of skill / mcp / subagent descriptors exposed to the
 * frontend selector.
 *
 * Each entry is a thin description (id, label, description, optional hint)
 * — the runtime layer (loading / sandbox / routing) is intentionally NOT
 * built yet. For MVP, selected ids are passed through to opencode as a
 * message-prefix hint. See [[full-runtime-roadmap]] for the next phase.
 *
 * Keep this file a pure data module — no I/O, no side effects — so it is
 * cheap to import from both HTTP handlers and tests.
 */

export type RegistryKind = "agent" | "skill" | "mcp";

export interface RegistryEntry {
  /** Stable id used in the API and the message-prefix hint. */
  id: string;
  /** Display name (zh-CN, since the UI labels are Chinese). */
  label: string;
  /** One-line description shown in the picker. */
  description: string;
  /**
   * Optional backend hint (opencode flag, env var, etc.). Free-form for now;
   * future runtime will interpret this.
   */
  hint?: string;
}

/**
 * Subagents — corresponds to opencode's `--agent` flag. Only one can be
 * active per turn, but the picker still treats them as multi-selectable
 * client-side; the runner picks the first selected id.
 */
export const AGENTS: RegistryEntry[] = [
  {
    id: "general",
    label: "通用助手",
    description: "默认通用 Agent，能调用大部分内置工具",
    hint: "opencode --agent general",
  },
  {
    id: "code-reviewer",
    label: "代码审查",
    description: "聚焦代码 diff、潜在 bug 与改进建议",
    hint: "opencode --agent code-reviewer",
  },
  {
    id: "researcher",
    label: "研究助理",
    description: "偏向多轮搜索与文档整理",
    hint: "opencode --agent researcher",
  },
];

/**
 * Skills — named playbooks / prompt fragments. Selected ids are appended
 * to the message prefix so the model can recognize them.
 */
export const SKILLS: RegistryEntry[] = [
  {
    id: "web-search",
    label: "联网搜索",
    description: "在回答前先检索最新公开信息",
  },
  {
    id: "code-search",
    label: "代码检索",
    description: "优先在仓库内搜索相关代码片段",
  },
  {
    id: "summarize",
    label: "结构化总结",
    description: "用要点 + 表格输出结论",
  },
  {
    id: "translate",
    label: "中英互译",
    description: "回复时保持术语一致",
  },
];

/**
 * MCP servers — external tool providers. For MVP these are listed but not
 * yet wired to a stdio subprocess; selecting one only annotates the prompt.
 */
export const MCP_SERVERS: RegistryEntry[] = [
  {
    id: "github",
    label: "GitHub",
    description: "仓库、Issue、PR 查询与变更",
    hint: "mcp:github",
  },
  {
    id: "filesystem",
    label: "本地文件",
    description: "受限访问工作区内的文件",
    hint: "mcp:filesystem",
  },
  {
    id: "browser",
    label: "浏览器",
    description: "远程浏览器渲染与抓取",
    hint: "mcp:browser",
  },
];

export interface RegistrySnapshot {
  agents: RegistryEntry[];
  skills: RegistryEntry[];
  mcps: RegistryEntry[];
}

/** Return a plain JSON-serializable snapshot for the HTTP API. */
export function getRegistry(): RegistrySnapshot {
  return {
    agents: AGENTS,
    skills: SKILLS,
    mcps: MCP_SERVERS,
  };
}

/**
 * Render the selected ids into a short message-prefix block. Kept here
 * (not in the runner) so both /api/chat and /api/action can reuse it
 * without duplicating the formatting.
 */
export function buildSelectionPrefix(
  selected: { agents?: string[]; skills?: string[]; mcps?: string[] } | undefined
): string {
  if (!selected) return "";
  const parts: string[] = [];
  if (selected.skills?.length) parts.push(`[Active Skills: ${selected.skills.join(", ")}]`);
  if (selected.mcps?.length) parts.push(`[Active MCPs: ${selected.mcps.join(", ")}]`);
  if (selected.agents?.length) parts.push(`[Active Agents: ${selected.agents.join(", ")}]`);
  return parts.join(" ");
}