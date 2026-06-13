import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSupabaseAdmin } from "@/lib/supabase";
import Chat from "../Chat";

export const dynamic = "force-dynamic";

async function loadSetter(slug: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("clients")
    .select("name, outbound")
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
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug } = await params;
  const setter = await loadSetter(slug);
  if (!setter) notFound();

  // Outbound (JAIra opens first) comes from the setter's flag, with an optional
  // ?outbound=1 / ?outbound=0 override that's handy for demoing both modes on a call.
  const sp = await searchParams;
  const override = Array.isArray(sp.outbound) ? sp.outbound[0] : sp.outbound;
  let outbound = !!setter.outbound;
  if (override === "1" || override === "true") outbound = true;
  if (override === "0" || override === "false") outbound = false;

  return <Chat slug={slug} name={setter.name ?? "Setter"} outbound={outbound} />;
}
