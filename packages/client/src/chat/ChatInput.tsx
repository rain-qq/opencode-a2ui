/**
 * Chat input (Coze-style).
 *
 * Single-line `<input>` is replaced with a self-growing `<textarea>`:
 *   Enter       -> submit
 *   Shift+Enter -> newline
 * Max height ~160px then scrolls.
 *
 * While `busy`, the Send button morphs into a Stop button that calls
 * `cancelChat()` -> POST /api/cancel -> ACP sessionCancel.
 *
 * Paperclip button opens a hidden `<input type=file multiple accept=image/*>`.
 * Selected files are uploaded via `uploadImage()` (MinIO) and rendered as
 * removable chips above the input. On submit, attachments are passed to
 * `sendChat` as a SEPARATE field (not embedded in the text message) so the
 * server can forward them to the model as ACP image parts — embedding them
 * as `![](url)` markdown only sends a text path that the model can't see.
 *
 * Empty-state suggestion chips appear above the input when the conversation
 * is empty (one click fills the textarea).
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentPicker } from "../agent/AgentPicker.js";
import { useA2UI } from "../a2ui/store.js";
import { cancelChat, sendChat, uploadImage } from "../a2ui/transport.js";

const SUGGESTIONS = [
  "计算 123*456，并把结果展示成卡片。",
  "查询演示餐厅数据，并渲染成列表。",
  "给我一个联系表单，要邮箱字段和提交按钮。",
  "用表格总结今天的工作计划。",
];

const MAX_TEXTAREA_HEIGHT = 160;

interface Attachment {
  /** Local id (key for React). */
  kid: string;
  /** Server-side url after upload (or empty while uploading). */
  url: string;
  /** Original data URI (kept so we can re-upload on retry / display preview). */
  dataUri: string;
  /** Original filename, for the chip label. */
  name: string;
  /** True until the upload resolves. */
  uploading: boolean;
  /** Set when the upload failed. */
  error?: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

export function ChatInput() {
  const busy = useA2UI((s) => s.busy);
  const conversationLength = useA2UI((s) => s.conversation.length);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow: cap height, then scroll.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
  }, [text]);

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    e.target.value = ""; // reset so picking the same file again still fires
    list.forEach((file) => {
      const kid = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const placeholder: Attachment = {
        kid,
        url: "",
        dataUri: "",
        name: file.name,
        uploading: true,
      };
      setAttachments((prev) => [...prev, placeholder]);
      readFileAsDataUrl(file)
        .then(async (dataUri) => {
          const url = await uploadImage(dataUri);
          setAttachments((prev) =>
            prev.map((a) =>
              a.kid === kid
                ? {
                    ...a,
                    dataUri,
                    url: url ?? "",
                    uploading: false,
                    error: url ? undefined : "上传失败",
                  }
                : a
            )
          );
        })
        .catch(() => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.kid === kid ? { ...a, uploading: false, error: "读取失败" } : a
            )
          );
        });
    });
  }

  function removeAttachment(kid: string) {
    setAttachments((prev) => prev.filter((a) => a.kid !== kid));
  }

  function submit() {
    if (busy) return;
    const msg = text.trim();
    const ready = attachments.filter((a) => !!a.url);
    if (!msg && ready.length === 0) return;
    setText("");
    setAttachments([]);
    // Attachments are sent as a SEPARATE field, not embedded as markdown in
    // the text. The server forwards each to the model as an ACP image part so
    // the model can actually see the image (a markdown link is just text).
    sendChat(
      msg,
      ready.map((a) => ({ url: a.url }))
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter -> send; Shift+Enter -> newline. IME composition: don't hijack.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  function onClickAttach() {
    fileInputRef.current?.click();
  }

  return (
    <div className="chat-input">
      {/* Empty-state suggestion chips */}
      {conversationLength === 0 && (
        <div className="chat-suggestions">
          {SUGGESTIONS.map((s, i) => (
            <button
              key={i}
              type="button"
              className="chat-suggestion"
              onClick={() => setText(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="chat-input-card">
        {/* Attachment chips (only when present) */}
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <div
                key={a.kid}
                className={
                  "chat-attachment" +
                  (a.uploading ? " uploading" : "") +
                  (a.error ? " error" : "")
                }
                title={a.error ?? a.name}
              >
                <img
                  className="chat-attachment-thumb"
                  src={a.url || a.dataUri}
                  alt={a.name}
                />
                <span className="chat-attachment-name">{a.name}</span>
                {!a.uploading && (
                  <button
                    type="button"
                    className="chat-attachment-remove"
                    onClick={() => removeAttachment(a.kid)}
                    aria-label="移除附件"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Textarea row — single, full-width, click anywhere to focus. No
            buttons live inside this row (Coze-style). */}
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          rows={1}
          value={text}
          placeholder={
            busy ? "生成中…(Enter 发送 / Shift+Enter 换行)" : "Ask the agent to render something or call a tool…"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {/* Toolbar row — left: paperclip + skill/mcp/agent chips;
            right: Send / Stop. Sits BELOW the textarea. */}
        <div className="chat-toolbar">
          <div className="chat-toolbar-left">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={onFiles}
            />
            <button
              type="button"
              className="chat-tool-btn"
              onClick={() => fileInputRef.current?.click()}
              title="添加图片附件"
              disabled={busy}
              aria-label="添加图片附件"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <AgentPicker />
          </div>
          <div className="chat-toolbar-right">
            {busy ? (
              <button
                type="button"
                className="chat-stop"
                onClick={() => void cancelChat()}
                title="停止生成"
              >
                <span className="chat-stop-square" aria-hidden />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                className="chat-send"
                onClick={submit}
                disabled={!text.trim() && attachments.every((a) => !a.url)}
                title="发送(Enter)"
              >
                <span>发送</span>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}