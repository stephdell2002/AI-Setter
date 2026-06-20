"use client";

import { useEffect, useRef, useState } from "react";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Mode = "inbound" | "outbound" | "auto";

// In "auto" mode the bot waits this long for the prospect to engage; if they stay
// silent it opens the conversation itself.
const AUTO_GREET_DELAY_MS = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Chat({
  slug,
  name,
  mode = "inbound",
  replyDelayMin = 3,
  replyDelayMax = 8,
}: {
  slug: string;
  name: string;
  mode?: Mode;
  replyDelayMin?: number;
  replyDelayMax?: number;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [leadId, setLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); // typing indicator
  const [sending, setSending] = useState(false); // composer busy
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initiatedRef = useRef(false);
  const engagedRef = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Reveal a reply as separate human-style texts: one bubble per line, each with a
  // short typing pause, so it reads like quick back-to-back messages.
  async function revealReply(text: string) {
    const parts = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = parts.length ? parts : ["you're all set, talk soon"];
    for (let i = 0; i < lines.length; i++) {
      setLoading(true);
      await sleep(Math.min(2200, Math.max(700, lines[i].length * 45)));
      setLoading(false);
      setMessages((prev) => [...prev, { role: "assistant", content: lines[i] }]);
      if (i < lines.length - 1) await sleep(450);
    }
  }

  function replyDelayMs() {
    const min = Math.max(0, replyDelayMin);
    const max = Math.max(min, replyDelayMax);
    return (min + Math.random() * (max - min)) * 1000;
  }

  // The bot opening the conversation itself (outbound / auto).
  useEffect(() => {
    if (initiatedRef.current) return;

    async function jairaOpens() {
      if (initiatedRef.current || engagedRef.current) return;
      initiatedRef.current = true;
      setSending(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, initiate: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Something went wrong.");
        if (data.leadId) setLeadId(data.leadId);
        await revealReply(data.reply);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        initiatedRef.current = false;
      } finally {
        setLoading(false);
        setSending(false);
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
    if (!text || sending) return;

    engagedRef.current = true; // prospect spoke; cancel any pending auto-open
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);
    setLoading(true);

    try {
      // Human reply delay: don't fire back instantly.
      await sleep(replyDelayMs());
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, leadId, message: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      if (data.leadId) setLeadId(data.leadId);
      await revealReply(data.reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
      setSending(false);
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
        <button type="submit" disabled={sending || !input.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
