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
  gender,
}: {
  slug: string;
  name: string;
  mode?: Mode;
  replyDelayMin?: number;
  replyDelayMax?: number;
  gender?: "male" | "female";
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false); // "…" indicator
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const leadIdRef = useRef<string | null>(null);
  const bootedRef = useRef(false); // mount effect ran once
  const openedRef = useRef(false); // bot already opened
  const engagedRef = useRef(false); // prospect has spoken / convo exists
  const seqRef = useRef(0); // increments on each prospect send (batching)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false); // a reply is being generated
  const storeChainRef = useRef<Promise<void>>(Promise.resolve());

  const storageKey = `nameless:lead:${slug}`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing]);

  function persistLead(id: string) {
    leadIdRef.current = id;
    try {
      localStorage.setItem(storageKey, id);
    } catch {}
  }

  // Reveal a reply as separate human-style texts: one bubble per line, each with a
  // short typing pause, so it reads like quick back-to-back messages.
  async function revealReply(text: string) {
    const parts = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const lines = parts.length ? parts : ["you're all set, talk soon"];
    for (let i = 0; i < lines.length; i++) {
      setTyping(true);
      await sleep(Math.min(2200, Math.max(700, lines[i].length * 45)));
      setTyping(false);
      setMessages((prev) => [...prev, { role: "assistant", content: lines[i] }]);
      if (i < lines.length - 1) await sleep(450);
    }
  }

  function replyDelayMs() {
    const min = Math.max(0, replyDelayMin);
    const max = Math.max(min, replyDelayMax);
    return (min + Math.random() * (max - min)) * 1000;
  }

  // ---- The Nameless Revival System (embedded) ----------------------------------
  // While this tab is open, the chat runs the setter's own follow-up schedule
  // itself: after every bot message the server says when the next bump is due and
  // we arm a timer for it. The server (lead row) stays the source of truth; the
  // timer only asks "due yet?", so a cron run or a second tab can never cause a
  // double-send. Pass null/undefined to just cancel.
  function armFollowup(ms?: number | null) {
    if (followupTimerRef.current) clearTimeout(followupTimerRef.current);
    followupTimerRef.current = null;
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    followupTimerRef.current = setTimeout(fireFollowup, Math.max(250, ms) + 400);
  }

  async function fireFollowup() {
    followupTimerRef.current = null;
    if (!leadIdRef.current) return;
    // A live reply is pending or generating; check back after it lands.
    if (inFlightRef.current || timerRef.current) {
      armFollowup(3000);
      return;
    }
    const mySeq = seqRef.current;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, leadId: leadIdRef.current, followup: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      // If the prospect typed while we fetched, skip the reveal (the message is
      // stored server-side and shows on the next load); their reply resets the
      // sequence anyway.
      if (data.reply && seqRef.current === mySeq) {
        await revealReply(data.reply);
      }
      if (!data.done) armFollowup(data.nextInMs);
    } catch {
      armFollowup(30000); // transient failure; try again in a bit
    }
  }

  // The bot opening the conversation itself (outbound / auto).
  async function botOpens() {
    if (openedRef.current || engagedRef.current) return;
    openedRef.current = true;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, initiate: true, ...(gender ? { gender } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      if (data.leadId) persistLead(data.leadId);
      await revealReply(data.reply);
      armFollowup(data.nextFollowupInMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      openedRef.current = false;
    }
  }

  // Mount: rehydrate an existing conversation if we have one, otherwise arm the
  // bot's opening behavior based on mode.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      // ?fresh=1 (or ?new / ?reset) forces a brand-new conversation on the latest
      // build, ignoring and clearing any saved thread in this browser. Handy for a
      // shareable demo link that never rehydrates someone's old chat.
      let forceFresh = false;
      try {
        const p = new URLSearchParams(window.location.search);
        const v = (p.get("fresh") ?? p.get("new") ?? p.get("reset") ?? "").toLowerCase();
        forceFresh = v === "1" || v === "true" || v === "yes";
      } catch {}

      let stored: string | null = null;
      try {
        stored = forceFresh ? null : localStorage.getItem(storageKey);
        if (forceFresh) localStorage.removeItem(storageKey);
      } catch {}

      if (stored) {
        try {
          const res = await fetch(`/api/chat?leadId=${encodeURIComponent(stored)}`);
          const data = await res.json();
          if (Array.isArray(data.messages) && data.messages.length) {
            leadIdRef.current = stored;
            engagedRef.current = true; // conversation exists; don't auto-open
            openedRef.current = true;
            setMessages(
              data.messages.map((m: ChatMessage) => ({
                role: m.role === "assistant" ? "assistant" : "user",
                content: m.content,
              }))
            );
            // Pick the sequence back up: the server says whether a follow-up is
            // due now, later (we arm the remaining time), or never (done/booked).
            fireFollowup();
            return;
          }
        } catch {}
      }

      if (mode === "outbound") {
        botOpens();
      } else if (mode === "auto") {
        autoTimerRef.current = setTimeout(botOpens, AUTO_GREET_DELAY_MS);
      }
    })();

    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (followupTimerRef.current) clearTimeout(followupTimerRef.current);
    };
  }, [mode, slug]);

  // Persist each prospect message immediately, in order (chained so the first send
  // establishes the lead before the next one fires, preventing duplicate leads).
  function storeMessage(text: string) {
    storeChainRef.current = storeChainRef.current
      .then(async () => {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            leadId: leadIdRef.current,
            message: text,
            store_only: true,
            ...(gender ? { gender } : {}),
          }),
        });
        const data = await res.json();
        if (data?.leadId) persistLead(data.leadId);
      })
      .catch(() => {});
  }

  // (Re)start the reply timer. Every new prospect message resets it, so a burst of
  // texts gets batched into one considered reply once they stop for a beat.
  function scheduleReply() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fireReply, replyDelayMs());
  }

  async function fireReply() {
    timerRef.current = null;
    if (inFlightRef.current) return; // in progress; it will re-check and reschedule
    const mySeq = seqRef.current;
    inFlightRef.current = true;
    try {
      await storeChainRef.current; // make sure every batched message is saved first
      setTyping(true); // only now does the bot "start typing"
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, leadId: leadIdRef.current, generate: true, ...(gender ? { gender } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Something went wrong.");
      if (data.leadId) persistLead(data.leadId);
      setTyping(false);
      if (seqRef.current !== mySeq) {
        // prospect texted more while we were generating; discard and re-batch
        inFlightRef.current = false;
        scheduleReply();
        return;
      }
      await revealReply(data.reply);
      armFollowup(data.nextFollowupInMs);
    } catch (err) {
      setTyping(false);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      inFlightRef.current = false;
    }
  }

  function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;

    engagedRef.current = true;
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    // Prospect spoke: the pending bump is off; a fresh clock is armed after the
    // bot's next reply (their message also resets the count server-side).
    armFollowup(null);
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    seqRef.current += 1;
    storeMessage(text);
    scheduleReply();
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <h1>{name}</h1>
      </header>

      <div className="messages">
        {messages.length === 0 && !typing && mode !== "outbound" && (
          <p className="empty">Say hey to start the conversation.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
          </div>
        ))}
        {typing && <div className="bubble assistant typing">…</div>}
        {error && <p className="error">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={sendMessage}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message"
          autoFocus
        />
        <button type="submit" disabled={!input.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
