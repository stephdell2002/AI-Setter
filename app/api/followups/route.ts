import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildSystemPrompt } from "@/lib/brain";
import {
  MODEL,
  OUTBOUND_CONTINUATION,
  FOLLOWUP_TRIGGER,
  FOLLOWUP_NEXT_DELAY_MS,
  MAX_FOLLOWUPS,
  sanitizeForProspect,
  toClaudeMessages,
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
  const nowIso = new Date().toISOString();

  // Due leads: still active, a bump is scheduled and past due, under the cap.
  const { data: due, error } = await supabase
    .from("leads")
    .select("id, client_id, followup_count")
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

      // Only bump if the bot genuinely spoke last. If the prospect replied but the
      // flag wasn't cleared for any reason, clear it and skip (never double-text them).
      if (msgs[msgs.length - 1].role !== "assistant") {
        await supabase.from("leads").update({ next_followup_at: null }).eq("id", lead.id);
        continue;
      }

      if (msgs[0].role === "assistant") {
        msgs.unshift({ role: "user", content: OUTBOUND_CONTINUATION });
      }
      msgs.push({ role: "user", content: FOLLOWUP_TRIGGER });

      const completion = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 300,
        system: buildSystemPrompt(client),
        messages: msgs,
      });
      const bump = sanitizeForProspect(
        completion.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      );
      if (!bump) continue;

      await supabase.from("messages").insert({
        lead_id: lead.id,
        client_id: client.id,
        role: "assistant",
        content: bump,
      });

      const count = (lead.followup_count ?? 0) + 1;
      const done = count >= MAX_FOLLOWUPS;
      await supabase
        .from("leads")
        .update({
          followup_count: count,
          status: done ? "nurture" : "active",
          next_followup_at: done
            ? null
            : new Date(Date.now() + FOLLOWUP_NEXT_DELAY_MS).toISOString(),
        })
        .eq("id", lead.id);
      bumped++;
    } catch (e) {
      console.error("followup failed for lead", lead.id, e);
    }
  }

  return NextResponse.json({ processed: (due ?? []).length, bumped });
}
