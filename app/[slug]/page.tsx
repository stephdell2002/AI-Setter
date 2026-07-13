import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSupabaseAdmin } from "@/lib/supabase";
import Chat from "../Chat";

export const dynamic = "force-dynamic";

type Mode = "inbound" | "outbound" | "auto";

async function loadSetter(slug: string) {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("clients")
    .select("name, outbound, opening_mode, reply_delay_min, reply_delay_max")
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

  // How the conversation opens: the setter's opening_mode ('inbound' | 'outbound'
  // | 'auto'), falling back to the older outbound flag. ?mode= and ?outbound=
  // overrides are handy for demoing each behavior on a call.
  const sp = await searchParams;
  const q = Array.isArray(sp.mode) ? sp.mode[0] : sp.mode;
  const ob = Array.isArray(sp.outbound) ? sp.outbound[0] : sp.outbound;
  // Optional gender hint for demoing the gendered address-term behavior. In
  // production the Instagram bridge sets this from the profile scan instead.
  const g = Array.isArray(sp.gender) ? sp.gender[0] : sp.gender;
  const gender = g === "male" || g === "female" ? g : undefined;

  let mode: Mode =
    setter.opening_mode === "outbound" || setter.opening_mode === "auto"
      ? setter.opening_mode
      : setter.outbound
        ? "outbound"
        : "inbound";

  if (q === "inbound" || q === "outbound" || q === "auto") mode = q;
  if (ob === "1" || ob === "true") mode = "outbound";
  if (ob === "0" || ob === "false") mode = "inbound";

  return (
    <Chat
      slug={slug}
      name={setter.name ?? "Setter"}
      mode={mode}
      replyDelayMin={setter.reply_delay_min ?? 3}
      replyDelayMax={setter.reply_delay_max ?? 8}
      gender={gender}
    />
  );
}
