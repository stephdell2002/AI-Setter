"use client";

import { useEffect, useRef, useState } from "react";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Mode = "inbound" | "outbound" | "auto";

// In "auto" mode JAIra waits this long for the prospect to engage; if they stay
// silent it opens the conversation itself. Tunable.
const AUTO_GREET_DELAY_MS = 4000;

export default function Chat({
  slug,
  name,
  mode = "inbound",
}: {
  slug: string;
  name: string;
  mode?: Mode;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [leadId, setLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initiatedRef = useRef(false);
  const engagedRef = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // JAIra opening the conversation itself. "outbound" opens immediately; "auto"
  // waits briefly and only opens if the prospect hasn't started engaging — so one
  // setter intelligently alternates between reaching out and waiting for inbound.
  useEffect(() => {
    if (initiatedRef.current) return;

    async function jairaOpens() {
      if (initiatedRef.current || engagedRef.current) return;
      initiatedRef.current = true;
      setLoading(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, initiate: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Something went wrong.");
        if (data.leadId) setLeadId(data.leadId);
        setMessages([{ role: "assistant", content: data.reply }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        initiatedRef.current = false;
      } finally {
        setLoading(false);
      }
    }

    if (mode === "outbound") {
      jairaOpens();
    } else if (mode === "auto") {
      const t = setTimeout(jairaOpens, AUTO_GREET_DELAY_MS);
      return () => clearTimeout(t);
    }
  }, [mode, slug]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    engagedRef.current = true; // prospect spoke; cancel any pending auto-open
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, leadId, message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      if (data.leadId) setLeadId(data.leadId);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.value.length > 0) engagedRef.current = true; // typing = engaged
    setInput(e.target.value);
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <h1>{name}</h1>
      </header>

      <div className="messages">
        {messages.length === 0 && !loading && mode !== "outbound" && (
          <p className="empty">Say hey to start the conversation.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
          </div>
        ))}
        {loading && <div className="bubble assistant typing">…</div>}
        {error && <p className="error">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={sendMessage}>
        <input
          type="text"
          value={input}
          onChange={onInputChange}
          placeholder="Type a message"
          autoFocus
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
