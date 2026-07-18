// Shared bits used by both the live chat route and the follow-up cron, so a bumped
// message goes through the exact same voice and safety net as a normal reply.

export const MODEL = "claude-sonnet-4-6";

// Follow-up bumps are short, low-stakes nudges, so they run on a cheaper/faster
// model than the live discovery replies. Swap back to MODEL if you want bumps to
// match the live voice exactly.
export const FOLLOWUP_MODEL = "claude-haiku-4-5-20251001";

// Synthetic opening user turn for a cold-outbound kickoff (never stored).
export const OUTBOUND_TRIGGER =
  "[You are starting a cold outbound conversation. This prospect has not messaged yet, you are reaching out first. Send only your opening message: short, warm, human, and curiosity sparking, ending with one easy question that invites a reply. Follow your tone rules. Do not pitch or mention booking yet.]";

// Prepended on later turns of an outbound-started chat only to satisfy the API's
// "first turn must be user" rule. Carries NO opener-only prohibitions.
export const OUTBOUND_CONTINUATION =
  "[Context: you opened this conversation cold; the prospect has since replied. Continue naturally per your normal flow, including qualifying and booking when appropriate.]";

// ---- Pipeline Revival Engine -------------------------------------------------
// Proven 5-step re-engagement sequence (the production default). Each delay is
// measured from the moment the setter last spoke with no reply from the prospect:
//   #1  24h after the setter's last message
//   #2  24h after #1
//   #3  24h after #2
//   #4  96h after #3
//   #5  3 weeks after #4  (the revival attempt, the whole point of the system)
// Every setter can carry its OWN schedule in clients.followup_delays_seconds (an
// array of delays in seconds), so each sold setter's cadence is tunable per client
// without touching code. NULL/empty/invalid falls back to this default.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const FOLLOWUP_SCHEDULE_MS = [24 * HOUR, 24 * HOUR, 24 * HOUR, 96 * HOUR, 21 * DAY];
export const MAX_FOLLOWUPS = FOLLOWUP_SCHEDULE_MS.length; // 5

// The effective schedule (in ms) for a setter: its own followup_delays_seconds when
// valid, otherwise the production default.
export function followupScheduleMs(delaysSeconds?: number[] | null): number[] {
  if (
    Array.isArray(delaysSeconds) &&
    delaysSeconds.length > 0 &&
    delaysSeconds.every((s) => Number.isFinite(s) && s > 0)
  ) {
    return delaysSeconds.map((s) => Math.round(s * 1000));
  }
  return FOLLOWUP_SCHEDULE_MS;
}

// Time to the NEXT follow-up on a schedule given how many were already sent, so the
// chat route (0 sent) schedules #1 and each send chains the next.
export function nextFollowupDelayMs(scheduleMs: number[], sentSoFar: number): number {
  return scheduleMs[sentSoFar] ?? scheduleMs[scheduleMs.length - 1];
}

// Back-compat: next delay on the default schedule.
export function followupDelayMs(sentSoFar: number): number {
  return nextFollowupDelayMs(FOLLOWUP_SCHEDULE_MS, sentSoFar);
}

// The instruction appended as the final user turn when a follow-up is generated
// (by the cron or by the chat's own embedded engine). `n` is which follow-up this
// is (1..total) on the setter's own schedule; the tone escalates gently, and the
// final step is the real revival re-opener after a long gap.
export function followupTrigger(n: number, total: number = MAX_FOLLOWUPS): string {
  if (n >= total)
    return "[SYSTEM: It has been a long stretch since this prospect went quiet. This is a genuine revival attempt, a warm re-opener, not a guilt trip. In your normal texting voice, reach back out like a real person circling back after a while: acknowledge lightly that it has been a minute, reference where you left off in a natural way, and give them an easy, no-pressure way back in (timing may have changed, could be a better moment now). One or two very short texts, end on one soft easy question. No 'just following up', no pressure, no salesy push.]";
  if (n === total - 1)
    return "[SYSTEM: The prospect has gone quiet through a few nudges and a while has passed. Send ONE relaxed, no-pressure check-in in your normal texting voice, a little more direct than a first nudge but still warm and totally unbothered, referencing where you left off. One or two very short texts, end on one easy question. No guilt, no 'just following up', no salesy push.]";
  return "[SYSTEM: The prospect went quiet after your last message and some time has passed. Send ONE light, casual, no-pressure nudge to revive the chat, in your normal texting voice, referencing where you left off in a natural way. One or two very short texts. No 'just following up', no guilt, no salesy push. A small easy question to re-open is fine. This is a bump, not a fresh conversation.]";
}

// Back-compat alias (a plain first-nudge trigger) for any caller not passing a number.
export const FOLLOWUP_TRIGGER = followupTrigger(1);

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
