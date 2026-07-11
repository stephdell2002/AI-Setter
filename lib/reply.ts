// Shared bits used by both the live chat route and the follow-up cron, so a bumped
// message goes through the exact same voice and safety net as a normal reply.

export const MODEL = "claude-sonnet-4-6";

// Synthetic opening user turn for a cold-outbound kickoff (never stored).
export const OUTBOUND_TRIGGER =
  "[You are starting a cold outbound conversation. This prospect has not messaged yet, you are reaching out first. Send only your opening message: short, warm, human, and curiosity sparking, ending with one easy question that invites a reply. Follow your tone rules. Do not pitch or mention booking yet.]";

// Prepended on later turns of an outbound-started chat only to satisfy the API's
// "first turn must be user" rule. Carries NO opener-only prohibitions.
export const OUTBOUND_CONTINUATION =
  "[Context: you opened this conversation cold; the prospect has since replied. Continue naturally per your normal flow, including qualifying and booking when appropriate.]";

// Appended as the final user turn when the follow-up cron revives a silent lead.
export const FOLLOWUP_TRIGGER =
  "[SYSTEM: The prospect went quiet after your last message and some time has passed. Send ONE light, casual, no-pressure nudge to revive the chat, in your normal texting voice, referencing where you left off in a natural way. One or two very short texts. No 'just following up', no guilt, no salesy push. A small easy question to re-open is fine. This is a bump, not a fresh conversation.]";

// Follow-up cadence. First bump is scheduled this long after the bot's reply; the
// daily cron picks it up on its next run. Second bump waits longer, then we stop.
export const FOLLOWUP_FIRST_DELAY_MS = 18 * 60 * 60 * 1000; // ~18h
export const FOLLOWUP_NEXT_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // ~3 days
export const MAX_FOLLOWUPS = 2;

// Strip internal tags and neutralize any dash the model slips past the prompt rules
// (dashes are the #1 AI tell), without mangling real words. Returns prospect-safe text.
export function sanitizeForProspect(raw: string): string {
  return raw
    .replace(/<{1,}\s*BOOKED\s*>{0,}/gi, "")
    .replace(/<<<CLOSER_BRIEF[\s\S]*?CLOSER_BRIEF>>>/g, "")
    .replace(/<<<CLOSER_BRIEF[\s\S]*$/g, "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/(^|\n)\s*,\s*/g, "$1")
    .trim();
}

// ---- Cadence enforcement -------------------------------------------------
// The #1 remaining human-ness tell is rhythm: a real setter does NOT end every
// reply with a question. Prompt rules alone kept failing (the model drifts back
// to interrogating), so we enforce cadence deterministically in code, the same
// belt-and-suspenders approach that took dashes to ~0%.

// True if the reply's LAST bubble/line ends on a question. We strip trailing
// emoji, quotes, spaces (anything that isn't a letter/digit or terminal
// punctuation) off the end first, so "before the call? 💪" still counts and a
// lone "🤙" does not.
export function endsWithQuestion(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const lastLine = (t.split(/\n+/).pop() ?? "").trim();
  const tail = lastLine.replace(/[^A-Za-z0-9?.!]+$/u, "");
  return tail.endsWith("?");
}

// How many of the most-recent consecutive assistant replies ended in a question.
// Users sit between assistant turns in the history, so we walk the assistant
// turns only. A return of >= 2 means the bot is in an interrogation run.
export function assistantQuestionStreak(
  history: { role: string; content: string | null }[]
): number {
  const bots = (history ?? []).filter((m) => m.role === "assistant");
  let streak = 0;
  for (let i = bots.length - 1; i >= 0; i--) {
    if (endsWithQuestion(bots[i].content ?? "")) streak++;
    else break;
  }
  return streak;
}

// Appended to the final user turn (clearly marked, never stored) when the bot has
// already ended its last two replies with a question. Forces a pure "react and
// breathe" beat this turn instead of a third straight question.
export const NO_QUESTION_DIRECTIVE =
  "\n\n[CADENCE OVERRIDE, not from them: your last two replies both ended in a question. This reply must contain ZERO questions and no calendar/booking ask. Just react to what they just said in your own voice, one or two short lines, like a real person going 'man that's rough' or 'yeah 40 down would be a whole different life', then stop. Save the next qualifying question for your following turn.]";

// Safety net if the model ignores the override and still tacks on a question. If
// the reply has a clean non-question part before the trailing question (a separate
// bubble, or an earlier sentence), keep that and drop the question. If the whole
// reply is nothing but a question we leave it alone (stripping to empty is worse).
export function dropTrailingQuestion(text: string): string {
  const t = String(text ?? "").trim();
  if (!t || !endsWithQuestion(t)) return t;

  // Prefer bubble boundaries (blank line between texts).
  const bubbles = t.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (bubbles.length > 1 && endsWithQuestion(bubbles[bubbles.length - 1])) {
    const kept = bubbles.slice(0, -1).join("\n\n").trim();
    if (kept && !endsWithQuestion(kept)) return kept;
    if (kept) return dropTrailingQuestion(kept);
  }

  // Single bubble: try to drop just the trailing question sentence.
  const lastBubble = bubbles[bubbles.length - 1] ?? t;
  const sentences = lastBubble.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (sentences && sentences.length > 1) {
    const head = sentences.slice(0, -1).join("").trim();
    if (head && !endsWithQuestion(head)) {
      const prefix = bubbles.slice(0, -1).join("\n\n");
      return (prefix ? prefix + "\n\n" + head : head).trim();
    }
  }

  return t;
}

type HistoryRow = { role: string; content: string | null };
export type ChatTurn = { role: "user" | "assistant"; content: string };

export function toClaudeMessages(history: HistoryRow[]): ChatTurn[] {
  return (history ?? []).map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: String(m.content ?? ""),
  }));
}
