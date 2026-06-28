import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keep-alive: a daily Vercel cron hits this and runs one tiny query, which counts
// as database activity and stops the free-tier Supabase project from auto-pausing.
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("clients").select("id").limit(1);
    if (error) throw error;
    return NextResponse.json({ ok: true, pinged: true });
  } catch (err) {
    console.error("keepalive error:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
