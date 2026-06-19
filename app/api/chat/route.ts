import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildSystemPrompt, BRIEF_PROMPT } from "@/lib/brain";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 500;

// Sent as a synthetic opening user turn when a setter runs in cold-outbound mode
// (JAIra messages first). It is never stored; it elicits the opener and, on later
// turns, keeps the message list valid (the API requires it to start with a user turn).
const OUTBOUND_TRIGGER =
  "[You are starting a cold outbound conversation. This prospect has not messaged yet, you are reaching out first. Send only your opening message: short, warm, human, and curiosity sparking, ending with one easy question that invites a reply. Follow your tone rules. Do not pitch or mention booking yet.]";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = String(body?.message ?? "").trim();
    let leadId: string | null = body?.leadId ? String(body.leadId) : null;
    const slug = body?.slug ? String(body.slug).trim() : null;
    // Cold-outbound kickoff: JAIra opens the conversation with no user message.
    const initiate = body?.initiate === true;

    if (!initiate && !message) {
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

    // 3. Save the incoming user message (none on an outbound kickoff).
    if (!initiate) {
      const { error: insertUserError } = await supabase.from("messages").insert({
        lead_id: leadId,
        client_id: client.id,
        role: "user",
        content: message,
      });
      if (insertUserError) throw insertUserError;
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

    // The Anthropic API requires the first turn to be from the user. On an outbound
    // kickoff there is no history; on later turns of an outbound-started chat the
    // stored history begins with JAIra's opener, so prepend the (unstored) trigger
    // to keep the sequence valid and give the model context for why it opened.
    if (initiate || claudeMessages[0]?.role === "assistant") {
      claudeMessages.unshift({ role: "user" as const, content: OUTBOUND_TRIGGER });
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

    // The brief is NEVER produced in the conversation. Detect the silent booking
    // signal, then strip it (and any stray internal tags) so nothing leaks to chat.
    const booked = /<<<BOOKED>>>/.test(reply);
    const safeReply =
      reply
        .replace(/<<<BOOKED>>>/g, "")
        .replace(/<<<CLOSER_BRIEF[\s\S]*?CLOSER_BRIEF>>>/g, "")
        .trim() || "you're all set, talk soon!";

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
    // transcript) and store it closer-only. Its content never touches the conversation.
    if (booked) {
      try {
        const transcript = [
          ...(history ?? []).map((m) => `${m.role}: ${m.content}`),
          `assistant: ${safeReply}`,
        ].join("\n");
        const briefCompletion = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 700,
          system: BRIEF_PROMPT,
          messages: [
            {
              role: "user",
              content: `Conversation transcript:\n\n${transcript}\n\nGenerate the closer brief now.`,
            },
          ],
        });
        const brief = briefCompletion.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        if (brief) {
          await supabase.from("leads").update({ closer_brief: brief }).eq("id", leadId);
        }
      } catch (briefErr) {
        console.error("closer brief generation failed:", briefErr);
      }
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
