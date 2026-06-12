import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildSystemPrompt } from "@/lib/brain";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 500;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = String(body?.message ?? "").trim();
    let leadId: string | null = body?.leadId ? String(body.leadId) : null;
    const slug = body?.slug ? String(body.slug).trim() : null;

    if (!message) {
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
      .select("id, system_prompt, active_rules, voice_samples, business_context")
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

    // 3. Save the incoming user message.
    const { error: insertUserError } = await supabase.from("messages").insert({
      lead_id: leadId,
      client_id: client.id,
      role: "user",
      content: message,
    });
    if (insertUserError) throw insertUserError;

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

    const safeReply = reply || "hey sorry, mind saying that again?";

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

    return NextResponse.json({ leadId, reply: safeReply });
  } catch (err) {
    console.error("chat route error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
