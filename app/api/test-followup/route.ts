// Manual trigger for the Nameless Revival System (testing): the exact same handler as
// /api/followups, kept as a separate path so it's easy to curl by hand.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export { GET } from "../followups/route";
