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

type HistoryRow = { role: string; content: string | null };
export type ChatTurn = { role: "user" | "assistant"; content: string };

export function toClaudeMessages(history: HistoryRow[]): ChatTurn[] {
  return (history ?? []).map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: String(m.content ?? ""),
  }));
}

// System-prompt addendum injected per conversation when the prospect's gender is
// known (e.g. from the Instagram bridge's profile scan, stored on the lead). Drives
// the gendered ADDRESS TERMS rule in the brain. Unknown gender returns "" so the
// brain default (no gendered address terms) applies.
export function genderContext(gender?: string | null): string {
  if (gender === "male")
    return "\n\n## PROSPECT CONTEXT\nThis prospect is a man. Light masculine address terms (man, bro, brother, g) are allowed, used sparingly and naturally in your voice.";
  if (gender === "female")
    return "\n\n## PROSPECT CONTEXT\nThis prospect is a woman. Do NOT use bro, man, brother, g, dude, my guy, or any masculine address term. Stay just as warm and human without them.";
  return "";
}
