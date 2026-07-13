import React, { useEffect, useRef, useState } from "react";
import { useA2UI } from "./a2ui/store.js";
import { ConversationView } from "./conversation/ConversationView.js";
import { ComponentGallery } from "./gallery/ComponentGallery.js";
import { HistorySidebar } from "./history/HistorySidebar.js";
import { ChatInput } from "./chat/ChatInput.js";

export function App() {
  const [view, setView] = useState<"chat" | "gallery">("chat");

  function openGallery() {
    // 切到示例页前清空，避免 chat 的残留 surface 串味。
    useA2UI.getState().reset();
    setView("gallery");
  }
  function exitGallery() {
    useA2UI.getState().reset();
    setView("chat");
  }

  if (view === "gallery") {
    return <ComponentGallery onExit={exitGallery} />;
  }
  return <ChatView onOpenGallery={openGallery} />;
}

function ChatView({ onOpenGallery }: { onOpenGallery: () => void }) {
  const sessionId = useA2UI((s) => s.sessionId);
  const conversationLength = useA2UI((s) => s.conversation.length);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [conversationLength]);

  return (
    <div className="app">
      <HistorySidebar />
      <div className="chat-pane">
        <div className="chat-header">
          <div className="chat-header-title">
            A2UI Agent
            <small>{sessionId.slice(0, 14)}…</small>
          </div>
          <div className="chat-header-actions">
            <button
              className="a2-button borderless"
              style={{ padding: "2px 8px", fontSize: 12 }}
              onClick={onOpenGallery}
            >
              组件示例
            </button>
          </div>
        </div>

        <div className="conversation-scroll" ref={scrollRef}>
          <ConversationView />
        </div>

        <ChatInput />
      </div>
    </div>
  );
}