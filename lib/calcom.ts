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
