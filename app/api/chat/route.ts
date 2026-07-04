import { NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildSystemPrompt, BRIEF_PROMPT } from "@/lib/brain";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 500;

// Sent as a synthetic opening user turn when a setter runs in cold-outbound mode
// (the bot messages first). Never stored; it elicits the very first message only.
const OUTBOUND_TRIGGER =
  "[You are starting a cold outbound conversation. This prospect has not messaged yet, you are reaching out first. Send only your opening message: short, warm, human, and curiosity sparking, ending with one easy question that invites a reply. Follow your tone rules. Do not pitch or mention booking yet.]";

// Prepended on later turns of an outbound-STARTED conversation only to satisfy the
// API's "first turn must be from the user" rule. It must NOT carry the opener-only
// prohibitions (no pitch / no booking), or the bot will refuse to book a warm lead.
const OUTBOUND_CONTINUATION =
  "[Context: you opened this conversation cold; the prospect has since replied. Continue naturally per your normal flow, including qualifying and booking when appropriate.]";

// Strip internal tags and neutralize any dash the model slips past the prompt rules
// (dashes are the #1 AI tell), without mangling real words. Returns the prospect-safe text.
function sanitizeForProspect(raw: string): string {
  return raw
    // Remove the booking signal in any near-miss form the model might emit.
    .replace(/<{1,}\s*BOOKED\s*>{0,}/gi, "")
    // Remove a fully-formed closer brief block, plus any unterminated trailing one.
    .replace(/<<<CLOSER_BRIEF[\s\S]*?CLOSER_BRIEF>>>/g, "")
    .replace(/<<<CLOSER_BRIEF[\s\S]*$/g, "")
    // Numeric ranges like 1,200-2,400 read naturally as "to".
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2")
    // Any remaining em/en dash used as punctuation becomes a comma.
    .replace(/\s*[—–]\s*/g, ", ")
    // Clean up a stray comma left at the start of a line/message.
    .replace(/(^|\n)\s*,\s*/g, "$1")
    .trim();
}

// Returns the stored transcript for a lead so the chat can rehydrate after a
// refresh or a return visit (the bot then keeps its memory instead of greeting
// the prospect with amnesia). Messages are already prospect-safe (no brief).
export async function GET(req: Request) {
  const leadId = new URL(req.url).searchParams.get("leadId");
  if (!leadId) return NextResponse.json({ messages: [] });
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return NextResponse.json({ messages: data ?? [] });
  } catch (err) {
    console.error("history fetch error:", err);
    return NextResponse.json({ messages: [] });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = String(body?.message ?? "").trim();
    let leadId: string | null = body?.leadId ? String(body.leadId) : null;
    const slug = body?.slug ? String(body.slug).trim() : null;
    // Cold-outbound kickoff: the bot opens with no user message.
    const initiate = body?.initiate === true;
    // store_only: persist the prospect's message without replying (lets the client
    // batch rapid-fire texts). generate: produce a reply from the stored history.
    const storeOnly = body?.store_only === true;
    const generate = body?.generate === true;

    if (!initiate && !generate && !message) {
      return NextResponse.json({ error: "Message is empty." }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server is missing ANTHROPIC_API_KEY." },
        { status: 500 }
      );
    }

    const supabase = getSupabaseAdmin();

    // 1. Load the setter config (the live training from the database). Each
    // sellable setter has its own `slug`; the chat UI sends it so we load that
    // specific setter. With no slug we fall back to the oldest active setter.
    const base = supabase
      .from("clients")
      .select("id, system_prompt, active_rules, voice_samples, business_context, full_prompt, identity_mode, client_sop")
      .eq("is_active", true);

    const { data: client, error: clientError } = slug
      ? await base.eq("slug", slug).maybeSingle()
      : await base.order("created_at", { ascending: true }).limit(1).maybeSingle();

    if (clientError) throw clientError;
    if (!client) {
      return NextResponse.json(
        { error: "Setter not found." },
        { status: 404 }
      );
    }

    // 2. Start a new lead (conversation) on the first message.
    if (!leadId) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({ client_id: client.id })
        .select("id")
        .single();
      if (leadError) throw leadError;
      leadId = lead.id as string;
    }

    // 3. Save the incoming user message (skipped on an outbound kickoff, or on a
    // pure generate call where the message was already stored via store_only).
    if (!initiate && !generate) {
      const { error: insertUserError } = await supabase.from("messages").insert({
        lead_id: leadId,
        client_id: client.id,
        role: "user",
        content: message,
      });
      if (insertUserError) throw insertUserError;
    }

    // store_only: the message is persisted; the client triggers generation once the
    // prospect stops typing, so a burst of texts gets one considered reply.
    if (storeOnly) {
      return NextResponse.json({ leadId });
    }

    // 4. Load the whole conversation so the setter remembers the chat.
    const { data: history, error: historyError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (historyError) throw historyError;

    const claudeMessages = (history ?? []).map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(m.content ?? ""),
    }));

    // The Anthropic API requires the first turn to be from the user. On the outbound
    // kickoff, send the opener-only trigger. On later turns of an outbound-started
    // chat the stored history begins with the bot's opener, so prepend a NEUTRAL
    // continuation stub (never the opener-only prohibitions) to keep ordering valid.
    if (initiate) {
      claudeMessages.unshift({ role: "user" as const, content: OUTBOUND_TRIGGER });
    } else if (claudeMessages[0]?.role === "assistant") {
      claudeMessages.unshift({ role: "user" as const, content: OUTBOUND_CONTINUATION });
    }

    // Nothing to reply to (e.g. a generate call with no stored history yet).
    if (claudeMessages.length === 0) {
      return NextResponse.json({ error: "Nothing to reply to yet." }, { status: 400 });
    }

    // 5. Build brain + live training and call Claude (server-side only).
    const system = buildSystemPrompt(client);
    const anthropic = new Anthropic({ apiKey });
    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: claudeMessages,
    });

    const reply = completion.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();

    if (completion.stop_reason === "max_tokens") {
      console.warn("reply hit max_tokens, may be truncated:", { leadId });
    }

    // The brief is NEVER produced in the conversation. Detect the silent booking
    // signal (tolerant of near-miss tags), then strip it and neutralize dashes so
    // nothing internal or bot-tell-y leaks to the prospect.
    const booked = /<{1,}\s*BOOKED\s*>{0,}/i.test(reply);
    const safeReply = sanitizeForProspect(reply) || "you're all set, talk soon";

    // 6. Save the assistant reply.
    const { error: insertAssistantError } = await supabase
      .from("messages")
      .insert({
        lead_id: leadId,
        client_id: client.id,
        role: "assistant",
        content: safeReply,
      });
    if (insertAssistantError) throw insertAssistantError;

    // On a confirmed booking, generate the Closer Brief in a SEPARATE call (off the
    // transcript) and store it closer-only. Run it AFTER the response so the
    // booking-confirmation reply isn't delayed by a second model call; after() keeps
    // the work alive in the serverless runtime past the HTTP response.
    if (booked) {
      const closedTranscript = [
        ...(history ?? []).map((m) => `${m.role}: ${m.content}`),
        `assistant: ${safeReply}`,
      ].join("\n");
      const briefLeadId = leadId;
      const briefClientId = client.id;
      after(async () => {
        try {
          const briefCompletion = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 700,
            system: BRIEF_PROMPT,
            messages: [
              {
                role: "user",
                content: `Conversation transcript:\n\n${closedTranscript}\n\nGenerate the closer brief now.`,
              },
            ],
          });
          const brief = briefCompletion.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("")
            .trim();
          if (brief) {
            await supabase.from("leads").update({ closer_brief: brief }).eq("id", briefLeadId);
          }
        } catch (briefErr) {
          console.error("closer brief generation failed:", briefErr, { briefLeadId, briefClientId });
        }
      });
    }

    return NextResponse.json({ leadId, reply: safeReply });
  } catch (err) {
    console.error("chat route error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
