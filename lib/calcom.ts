// Cal.com v2 API client. Lets the setter read real availability and create bookings,
// so it can offer genuine open times and lock the call in directly (no link).
// The API key lives ONLY in the CALCOM_API_KEY env var (Vercel), never in code.

const BASE = "https://api.cal.com/v2";

// Username + event slug come from the public booking link
// (https://cal.com/<username>/<slug>); overridable via env. Not secrets.
const USERNAME = () => process.env.CALCOM_USERNAME || "oliver-s.-delly-mk02fl";
const EVENT_SLUG = () => process.env.CALCOM_EVENT_SLUG || "1hr";

export function calConfigured(): boolean {
  return !!process.env.CALCOM_API_KEY;
}

type CalResult = { ok: boolean; status: number; json: unknown };

async function calFetch(
  path: string,
  opts: { version?: string; method?: string; body?: unknown } = {}
): Promise<CalResult> {
  const apiKey = process.env.CALCOM_API_KEY;
  if (!apiKey) throw new Error("CALCOM_API_KEY not set");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (opts.version) headers["cal-api-version"] = opts.version;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, json };
}

// The authed account's event types (used to resolve the numeric event type id).
export async function getEventTypes(): Promise<CalResult> {
  return calFetch(`/event-types?username=${encodeURIComponent(USERNAME())}`, {
    version: "2024-06-14",
  });
}

let cachedEventTypeId: number | null = null;
export async function resolveEventTypeId(): Promise<number | null> {
  if (process.env.CALCOM_EVENT_TYPE_ID) return Number(process.env.CALCOM_EVENT_TYPE_ID);
  if (cachedEventTypeId) return cachedEventTypeId;
  const r = await getEventTypes();
  const data = (r.json as { data?: unknown })?.data;
  const list: Array<{ id?: number; slug?: string }> = Array.isArray(data)
    ? (data as Array<{ id?: number; slug?: string }>)
    : [];
  const match = list.find((e) => e.slug === EVENT_SLUG()) ?? list[0];
  if (match?.id) {
    cachedEventTypeId = Number(match.id);
    return cachedEventTypeId;
  }
  return null;
}

// Real open slots for an event type between two dates (YYYY-MM-DD), in a timezone.
export async function getSlotsRaw(params: {
  eventTypeId: number;
  start: string;
  end: string;
  timeZone: string;
}): Promise<CalResult> {
  const q = new URLSearchParams({
    eventTypeId: String(params.eventTypeId),
    start: params.start,
    end: params.end,
    timeZone: params.timeZone,
  });
  return calFetch(`/slots?${q.toString()}`, { version: "2024-09-04" });
}

// Create a real booking (sends the invite). start is a full ISO 8601 slot start.
export async function createBookingRaw(params: {
  eventTypeId: number;
  start: string;
  name: string;
  email: string;
  timeZone: string;
}): Promise<CalResult> {
  return calFetch(`/bookings`, {
    version: "2024-08-13",
    method: "POST",
    body: {
      start: params.start,
      eventTypeId: params.eventTypeId,
      attendee: {
        name: params.name,
        email: params.email,
        timeZone: params.timeZone,
        language: "en",
      },
    },
  });
}

// ---- Higher-level helpers used by the setter's booking tools -----------------

export type OpenSlot = { start: string; label: string; meridiem: "AM" | "PM" };
export type OpenDay = { date: string; weekday: string; suggested: OpenSlot[]; slots: OpenSlot[] };

// Pick up to 3 real slots spread across the day (favoring an AM + a couple PM) so the
// setter has a small, exact set to offer, no need to improvise times.
function pickSpread(slots: OpenSlot[]): OpenSlot[] {
  if (slots.length <= 3) return slots;
  const am = slots.filter((s) => s.meridiem === "AM");
  const pm = slots.filter((s) => s.meridiem === "PM");
  const picks: OpenSlot[] = [];
  if (am.length) picks.push(am[0]);
  if (pm.length) picks.push(pm[Math.floor(pm.length / 2)]);
  if (pm.length > 1) picks.push(pm[pm.length - 1]);
  const pool = slots.filter((s) => !picks.includes(s));
  while (picks.length < 3 && pool.length) picks.push(pool.shift()!);
  return picks.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3);
}

// The soonest `maxDays` days (from tomorrow) that actually have open slots, each
// with human-readable, AM/PM-labeled times in the prospect's timezone. The setter
// offers 2-3 mixed AM/PM from these; the times are real, so no invented slots.
export async function getOpenDays(timeZone: string, maxDays = 2): Promise<OpenDay[]> {
  const eventTypeId = await resolveEventTypeId();
  if (!eventTypeId) return [];
  const now = Date.now();
  const start = new Date(now + 24 * 3600 * 1000).toISOString().slice(0, 10); // tomorrow
  const end = new Date(now + 8 * 24 * 3600 * 1000).toISOString().slice(0, 10); // +8 days
  const r = await getSlotsRaw({ eventTypeId, start, end, timeZone });
  const byDate = ((r.json as { data?: Record<string, Array<{ start: string }>> })?.data) ?? {};

  const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone });
  const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const hour24Fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone });

  const days: OpenDay[] = [];
  for (const date of Object.keys(byDate).sort()) {
    const arr = byDate[date] ?? [];
    if (!arr.length) continue;
    const slots: OpenSlot[] = arr.map((s) => {
      const d = new Date(s.start);
      const hour = Number(hour24Fmt.format(d));
      return { start: s.start, label: timeFmt.format(d), meridiem: hour < 12 ? "AM" : "PM" };
    });
    days.push({
      date,
      weekday: weekdayFmt.format(new Date(arr[0].start)),
      suggested: pickSpread(slots),
      slots,
    });
    if (days.length >= maxDays) break;
  }
  return days;
}

// Create the booking. Returns success + a confirmation, or a failure the setter can
// handle by falling back to the link (never by pretending it booked).
export async function bookCall(params: {
  start: string;
  name: string;
  email: string;
  timeZone: string;
}): Promise<{ success: boolean; uid?: string; error?: string }> {
  const eventTypeId = await resolveEventTypeId();
  if (!eventTypeId) return { success: false, error: "event type not resolved" };
  try {
    const r = await createBookingRaw({ eventTypeId, ...params });
    if (r.ok) {
      const uid = (r.json as { data?: { uid?: string } })?.data?.uid;
      return { success: true, uid };
    }
    // Log the full response so a shape mismatch is diagnosable from the runtime logs.
    console.error("cal.com booking failed:", r.status, JSON.stringify(r.json));
    return { success: false, error: `cal.com returned ${r.status}` };
  } catch (e) {
    console.error("cal.com booking threw:", e);
    return { success: false, error: String(e) };
  }
}
