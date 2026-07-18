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

const BATCH = 10;
const CLIENT_FIELDS =
  "id, system_prompt, active_rules, voice_samples, business_context, full_prompt, identity_mode, client_sop, client_profile";

// Test endpoint: manually trigger followups (for testing only, no auth required)
export async function GET(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY." },
      { status: 500 }
    );
  }

  const supabase = getSupabaseAdmin();
  const anthropic = new Anthropic({ apiKey });

  try {
    const { data: n } = await supabase.rpc("enroll_cold_leads", { p_batch: 300 });
    const enrolled = typeof n === "number" ? n : 0;

    const nowIso = new Date().toISOString();

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
      return NextResponse.json({ error: "query failed", details: error }, { status: 500 });
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
  } catch (err) {
    console.error("test followup error:", err);
    return NextResponse.json(
      { error: "Something went wrong.", details: String(err) },
      { status: 500 }
    );
  }
}
