import { useEffect, useRef, useState } from "react";
import { connection } from "../net/connection";
import { myId, set, useStore } from "../state/store";

export function Chat({ compact }: { compact?: boolean }) {
  const chat = useStore((s) => s.chat);
  const connected = useStore((s) => s.conn === "connected");
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const me = myId();

  // Seeing the chat clears the unread badge.
  useEffect(() => {
    set({ unread: 0 });
  }, [chat.length]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (connection.send({ type: "chat", text: t })) setText("");
  };

  const shown = compact ? chat.slice(-100) : chat;
  return (
    <div className={`chat ${compact ? "compact" : ""}`} data-testid="chat">
      <div className="chat-list" ref={listRef}>
        {shown.length === 0 && <div className="muted small">Say hi 👋</div>}
        {shown.map((m) => (
          <div key={m.id} className={`chat-msg ${m.from.id === me ? "mine" : ""}`}>
            <span className="chat-from">{m.from.id === me ? "You" : m.from.name}</span>
            <span className="chat-text">{m.text}</span>
          </div>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={text}
          maxLength={1000}
          placeholder={connected ? "Send a message…" : "Not connected"}
          disabled={!connected}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="submit" disabled={!connected || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
