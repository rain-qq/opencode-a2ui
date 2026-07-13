/**
 * Left sidebar conversation history (Coze-style).
 *
 * Renders a list of past conversations (newest first) from the server's file-
 * backed history store. Clicking an entry loads it back into the chat
 * (rehydrates the conversation timeline + sets opencodeSessionId so subsequent
 * turns continue the opencode session via session/load).
 *
 * Per-row hover actions: rename (pencil) + delete (trash). A "新建对话"
 * button at the top starts a fresh session. Search box filters by title.
 */

import React, { useEffect, useState } from "react";
import { useA2UI, type HistoryEntry } from "../a2ui/store.js";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function HistorySidebar() {
  const history = useA2UI((s) => s.history);
  const loading = useA2UI((s) => s.historyLoading);
  const fetchHistory = useA2UI((s) => s.fetchHistory);
  const loadHistory = useA2UI((s) => s.loadHistory);
  const deleteHistory = useA2UI((s) => s.deleteHistory);
  const renameHistory = useA2UI((s) => s.renameHistory);
  const newChat = useA2UI((s) => s.newChat);
  const sessionId = useA2UI((s) => s.sessionId);

  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Refresh after a turn ends so the new entry / new preview shows up.
  useEffect(() => {
    const unsub = useA2UI.subscribe((s, prev) => {
      if (s.busy === false && prev.busy === true) {
        fetchHistory();
      }
    });
    return unsub;
  }, [fetchHistory]);

  const filtered = filter
    ? history.filter((h) => h.title.toLowerCase().includes(filter.toLowerCase()))
    : history;

  function startRename(e: React.MouseEvent, h: HistoryEntry) {
    e.stopPropagation();
    setEditingId(h.id);
    setEditingTitle(h.title);
  }

  function commitRename() {
    const title = editingTitle.trim();
    if (editingId && title) {
      renameHistory(editingId, title);
    }
    setEditingId(null);
    setEditingTitle("");
  }

  function onDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (confirm("删除该对话？此操作不可恢复。")) {
      deleteHistory(id);
      if (sessionId === id) newChat();
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button
          type="button"
          className="sidebar-new"
          onClick={newChat}
          title="开启新对话"
        >
          <span className="sidebar-new-icon">＋</span>
          <span>新建对话</span>
        </button>
        <input
          className="sidebar-search"
          type="text"
          placeholder="搜索对话…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="sidebar-list">
        {loading && history.length === 0 && (
          <div className="sidebar-empty">加载中…</div>
        )}
        {!loading && history.length === 0 && (
          <div className="sidebar-empty">
            <div className="sidebar-empty-title">还没有对话</div>
            <div className="sidebar-empty-hint">点上方"新建对话"开始</div>
          </div>
        )}
        {filtered.length === 0 && history.length > 0 && (
          <div className="sidebar-empty">无匹配对话</div>
        )}
        {filtered.map((h) => {
          const active = h.id === sessionId;
          return (
            <div
              key={h.id}
              className={"sidebar-item" + (active ? " active" : "")}
              onClick={() => editingId !== h.id && loadHistory(h.id)}
            >
              <div className="sidebar-item-main">
                {editingId === h.id ? (
                  <input
                    autoFocus
                    className="sidebar-item-rename"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") {
                        setEditingId(null);
                        setEditingTitle("");
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div className="sidebar-item-title" title={h.preview}>
                    {h.title || "新对话"}
                  </div>
                )}
                <div className="sidebar-item-meta">
                  <span>{relativeTime(h.updatedAt)}</span>
                </div>
              </div>
              {editingId !== h.id && (
                <div className="sidebar-item-actions">
                  <button
                    type="button"
                    className="sidebar-item-btn"
                    title="重命名"
                    onClick={(e) => startRename(e, h)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="sidebar-item-btn danger"
                    title="删除"
                    onClick={(e) => onDelete(e, h.id)}
                  >
                    🗑
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}