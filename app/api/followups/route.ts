import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildSystemPrompt } from "@/lib/brain";
import {
  MODEL,
  OUTBOUND_CONTINUATION,
  followupTrigger,
  followupDelayMs,
  MAX_FOLLOWUPS,
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
  "id, system_prompt, active_rules, voice_samples, business_context, full_prompt, identity_mode, client_sop";

// Silent-lead follow-up engine. A daily Vercel cron hits this; it finds leads where
// the bot spoke last and the prospect went quiet, sends one casual no-pressure bump
// (same brain/voice as a live reply), and escalates up to MAX_FOLLOWUPS then parks
// the lead to nurture. Reset/opt-out is handled on the chat write path.
export async function GET(req: Request) {
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

  // Due leads: still active, a bump is scheduled and past due, under the cap.
  const { data: due, error } = await supabase
    .from("leads")
    .select("id, client_id, followup_count, gender")
    .eq("status", "active")
    .not("next_followup_at", "is", null)
    .lte("next_followup_at", nowIso)
    .lt("followup_count", MAX_FOLLOWUPS)
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
      //  - setter spoke last  -> send the next follow-up in the 5-step sequence.
      //  - prospect messaged and was never answered -> ANSWER them for real (this is
      //    not a follow-up; it starts the sequence clock at #0).
      const number = (lead.followup_count ?? 0) + 1;
      if (setterSpokeLast) {
        msgs.push({ role: "user", content: followupTrigger(number) });
      }

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: setterSpokeLast ? 300 : 500,
        system: buildSystemPrompt(client) + genderContext(lead.gender),
        messages: msgs,
      });
      const raw = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const reply = sanitizeForProspect(raw);
      if (!reply) continue;

      const booked = /<{1,}\s*BOOKED\s*>{0,}/i.test(raw);

      await supabase.from("messages").insert({
        lead_id: lead.id,
        client_id: client.id,
        role: "assistant",
        content: reply,
      });

      if (booked) {
        await supabase
          .from("leads")
          .update({ status: "booked", next_followup_at: null })
          .eq("id", lead.id);
      } else if (setterSpokeLast) {
        // After sending #number, park to nurture if that was the final (5th) revival,
        // otherwise schedule the next step per the 5-step cadence.
        const done = number >= MAX_FOLLOWUPS;
        await supabase
          .from("leads")
          .update({
            followup_count: number,
            status: done ? "nurture" : "active",
            next_followup_at: done
              ? null
              : new Date(Date.now() + followupDelayMs(number)).toISOString(),
          })
          .eq("id", lead.id);
      } else {
        // Answered a never-replied opt-in: start the follow-up clock fresh at #0.
        await supabase
          .from("leads")
          .update({
            status: "active",
            next_followup_at: new Date(Date.now() + followupDelayMs(0)).toISOString(),
          })
          .eq("id", lead.id);
      }
      bumped++;
    } catch (e) {
      console.error("followup failed for lead", lead.id, e);
    }
  }

  return NextResponse.json({ enrolled, processed: (due ?? []).length, bumped });
}
