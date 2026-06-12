import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSupabaseAdmin } from "@/lib/supabase";
import Chat from "../Chat";

export const dynamic = "force-dynamic";

async function loadSetter(slug: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("clients")
    .select("name")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  return data;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const setter = await loadSetter(slug);
  return { title: setter?.name ?? "Setter" };
}

export default async function SetterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const setter = await loadSetter(slug);
  if (!setter) notFound();
  return <Chat slug={slug} name={setter.name ?? "Setter"} />;
}
