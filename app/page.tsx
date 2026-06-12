import { redirect } from "next/navigation";

// The root URL points at the original setter. Each sellable copy lives at its
// own slug, e.g. /setter-1, served by app/[slug]/page.tsx.
export default function Home() {
  redirect("/demo");
}
