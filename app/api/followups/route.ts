import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildSystemPrompt } from "@/lib/brain";
import {
  MODEL,
  FOLLOWUP_MODEL,
  OUTBOUND_CONTINUATION,
  followupTrigger,
  followupScheduleMs,
  nextFollowupDelayMs,
  sanitizeForProspect,
  toClaudeMessages,
  genderContext,
} from "@/lib/reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Kept small so a run finishes inside the function time limit; each lead is committed
// as it's processed, so if a run is cut short the next run simply continues.
const BATCH = 10;

const CLIENT_FIELDS =
  "id, system_prompt, active_rules, voice_samples, business_context, full_prompt, identity_mode, client_sop, client_profile, followup_delays_seconds";

// Silent-lead follow-up engine. A daily Vercel cron hits this; it finds leads where
// the bot spoke last and the prospect went quiet, sends one casual no-pressure bump
// (same brain/voice as a live reply), and escalates up to MAX_FOLLOWUPS then parks
// the lead to nurture. Reset/opt-out is handled on the chat write path.
export async function GET(req: Request) {
  // For testing: allow manual triggering without auth. In production, set CRON_SECRET.
  // If CRON_SECRET is set, require it (Vercel cron sends it automatically).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server is missing ANTHROPIC_API_KEY." }, { status: 500 });
  }

  const supabase = getSupabaseAdmin();
  const anthropic = new Anthropic({ apiKey });

  // Mass-revival backfill: sweep a batch of forgotten cold leads (setter spoke last,
  // never enrolled, not opted out) into the sequence, due now. This is what lets the
  // engine work an existing backlog sequentially, not just brand-new conversations.
  let enrolled = 0;
  try {
    const { data: n } = await supabase.rpc("enroll_cold_leads", { p_batch: 300 });
    enrolled = typeof n === "number" ? n : 0;
  } catch (e) {
    console.error("enroll_cold_leads failed:", e);
  }

  const nowIso = new Date().toISOString();

  // Due leads: still active, a bump is scheduled and past due. The cap is enforced
  // per lead below, against the owning setter's OWN schedule length.
  const { data: due, error } = await supabase
    .from("leads")
    .select("id, client_id, followup_count, gender, next_followup_at")
    .eq("status", "active")
    .not("next_followup_at", "is", null)
    .lte("next_followup_at", nowIso)
    .order("next_followup_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    console.error("followups query failed:", error);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }

  let bumped = 0;
  for (const lead of due ?? []) {
    try {
      const { data: client } = await supabase
        .from("clients")
        .select(CLIENT_FIELDS)
        .eq("id", lead.client_id)
        .maybeSingle();
      if (!client) continue;

      // This setter's own Nameless Revival System cadence (per-row override or the default).
      const schedule = followupScheduleMs(client.followup_delays_seconds);
      const maxFollowups = schedule.length;
      const sent = lead.followup_count ?? 0;
      if (sent >= maxFollowups) {
        // Over this setter's cap: park it so it stops surfacing as due.
        await supabase
          .from("leads")
          .update({ status: "nurture", next_followup_at: null })
          .eq("id", lead.id);
        continue;
      }

      const { data: history } = await supabase
        .from("messages")
        .select("role, content")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: true });

      const msgs = toClaudeMessages(history ?? []);
      if (!msgs.length) continue;

      const setterSpokeLast = msgs[msgs.length - 1].role === "assistant";

      if (msgs[0].role === "assistant") {
        msgs.unshift({ role: "user", content: OUTBOUND_CONTINUATION });
      }

      // Two shapes reach this loop:
      //  - setter spoke last  -> send the next follow-up in the setter's sequence.
      //  - prospect messaged and was never answered -> ANSWER them for real (this is
      //    not a follow-up; it starts the sequence clock at #0).
      const number = sent + 1;
      if (setterSpokeLast) {
        msgs.push({ role: "user", content: followupTrigger(number, maxFollowups) });
      }

      // A bump (setter spoke last) runs on the cheaper follow-up model; answering a
      // never-replied prospect for real keeps the full-quality live model.
      const completion = await anthropic.messages.create({
        model: setterSpokeLast ? FOLLOWUP_MODEL : MODEL,
        max_tokens: setterSpokeLast ? 300 : 500,
        system: buildSystemPrompt(client) + genderContext(lead.gender),
        messages: msgs,
      });
      const raw = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const reply = sanitizeForProspect(raw);
      if (!reply) continue;

      const booked = /<{1,}\s*BOOKED\s*>{0,}/i.test(raw);

      // Claim the step BEFORE writing the message (compare-and-swap on
      // next_followup_at) so a racing cron run or the open chat tab can't
      // double-send the same bump.
      const done = number >= maxFollowups;
      const patch = booked
        ? { status: "booked", next_followup_at: null }
        : setterSpokeLast
          ? {
              followup_count: number,
              status: done ? "nurture" : "active",
              next_followup_at: done
                ? null
                : new Date(Date.now() + nextFollowupDelayMs(schedule, number)).toISOString(),
            }
          : {
              // Answered a never-replied opt-in: start the clock fresh at #0.
              status: "active",
              next_followup_at: new Date(Date.now() + nextFollowupDelayMs(schedule, 0)).toISOString(),
            };
      const { data: claimed } = await supabase
        .from("leads")
        .update(patch)
        .eq("id", lead.id)
        .eq("status", "active")
        .eq("next_followup_at", lead.next_followup_at)
        .select("id");
      if (!claimed?.length) continue; // another sender already handled this step

      await supabase.from("messages").insert({
        lead_id: lead.id,
        client_id: client.id,
        role: "assistant",
        content: reply,
      });
      bumped++;
    } catch (e) {
      console.error("followup failed for lead", lead.id, e);
    }
  }

  return NextResponse.json({ enrolled, processed: (due ?? []).length, bumped });
}
