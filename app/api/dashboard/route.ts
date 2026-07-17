import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Accountant's Dashboard (read-only). Per-setter metrics from the
// setter_dashboard view, each setter's numbers independent of the others.
//   GET /api/dashboard            -> every setter's row
//   GET /api/dashboard?slug=demo  -> just that setter
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug");
  try {
    const supabase = getSupabaseAdmin();
    let q = supabase.from("setter_dashboard").select("*");
    if (slug) q = q.eq("slug", slug);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ setters: data ?? [] });
  } catch (err) {
    console.error("dashboard fetch error:", err);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
