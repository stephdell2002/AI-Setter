import { NextResponse } from "next/server";
import { calConfigured, getEventTypes, resolveEventTypeId, getSlotsRaw } from "@/lib/calcom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Temporary diagnostic: verifies the Cal.com connection and shows the event types
// plus a sample of real open slots, so we can confirm shapes before wiring the
// self-booking into the setter. Open in a browser after CALCOM_API_KEY is set.
//   GET /api/calcom/diag            (defaults to America/New_York)
//   GET /api/calcom/diag?tz=America/Los_Angeles
export async function GET(req: Request) {
  if (!calConfigured()) {
    return NextResponse.json({
      ok: false,
      error: "CALCOM_API_KEY is not set in this environment yet.",
    });
  }
  const tz = new URL(req.url).searchParams.get("tz") || "America/New_York";
  try {
    const eventTypes = await getEventTypes();
    const eventTypeId = await resolveEventTypeId();

    let slots: { status: number; data: unknown } | null = null;
    if (eventTypeId) {
      const now = Date.now();
      const startDate = new Date(now + 24 * 3600 * 1000).toISOString().slice(0, 10);
      const endDate = new Date(now + 4 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const s = await getSlotsRaw({ eventTypeId, start: startDate, end: endDate, timeZone: tz });
      slots = { status: s.status, data: s.json };
    }

    return NextResponse.json({
      ok: true,
      resolvedEventTypeId: eventTypeId,
      timeZone: tz,
      eventTypes: { status: eventTypes.status, data: eventTypes.json },
      slots,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) });
  }
}
