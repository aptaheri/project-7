import { json } from '../lib/auth.mts'
import { requireTrackViewer } from '../lib/gate.mts'
import { loadRoute, rechainNextDay, saveDay, shiftFrom } from '../lib/route.mts'
import type { DayKind, SaveDay } from '../lib/route.mts'

/**
 * The route John edits from the road.
 *
 * Owner-only, because it is the thing the daily email and the tracker both
 * believe. A viewer reading it would learn nothing they cannot see on the map;
 * a viewer writing it could tell forty people he is somewhere he is not.
 *
 * GET returns a window around today rather than all 467 days: he is editing the
 * leg he just rode and the one he rides tomorrow, and nobody edits next March
 * from a phone in a French village.
 */

/** Days either side of today the editor can see and change. */
const BEFORE = 3
const AHEAD = 10

const KINDS: DayKind[] = ['ride', 'rest', 'travel', 'other']

function isCoords(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  )
}

export default async function handler(req: Request): Promise<Response> {
  const gate = await requireTrackViewer(req)
  if (gate instanceof Response) return gate
  if (gate.role !== 'owner') return json({ error: 'forbidden' }, 403)

  const today = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - BEFORE * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + AHEAD * 86_400_000)
    .toISOString()
    .slice(0, 10)

  try {
    if (req.method === 'GET') {
      const days = await loadRoute()
      return json({
        today,
        // Without the geometry: a routed day carries a thousand coordinates it
        // has no use for here, and this is read on a phone with one bar.
        days: days
          .filter((d) => d.date >= from && d.date <= until)
          .map(({ routeCoords: _routeCoords, ...day }) => day),
      })
    }

    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

    const body = (await req.json()) as Partial<SaveDay> & {
      rechain?: boolean
      shift?: { from?: unknown }
    }

    // Losing a day moves every day after it, which is one action rather than a
    // dozen saves. Handled here, before the single-day path, because it carries
    // no destination of its own — the days it writes already have theirs.
    if (body.shift) {
      const at = body.shift.from
      if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(at)) {
        return json({ error: 'shift.from must be a date' }, 400)
      }
      if (at < from || at > until) {
        return json({ error: `date must be between ${from} and ${until}` }, 400)
      }
      const moved = await shiftFrom(at, until, gate.email)
      if (moved === 0) {
        return json({ error: 'there is no earlier day to take a schedule from' }, 400)
      }
      const days = await loadRoute()
      return json({
        shifted: moved,
        today,
        days: days
          .filter((d) => d.date >= from && d.date <= until)
          .map(({ routeCoords: _routeCoords, ...day }) => day),
      })
    }

    if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return json({ error: 'a date is required' }, 400)
    }
    // Only the window the editor shows. Not a security boundary — he is an
    // owner — but a typo in a date should not silently rewrite next year.
    if (body.date < from || body.date > until) {
      return json({ error: `date must be between ${from} and ${until}` }, 400)
    }
    if (!body.kind || !KINDS.includes(body.kind)) {
      return json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400)
    }
    if (body.toCoords !== null && body.toCoords !== undefined && !isCoords(body.toCoords)) {
      return json({ error: 'toCoords must be [lon, lat]' }, 400)
    }
    if (body.fromCoords !== null && body.fromCoords !== undefined && !isCoords(body.fromCoords)) {
      return json({ error: 'fromCoords must be [lon, lat]' }, 400)
    }
    if (body.miles !== null && body.miles !== undefined) {
      if (typeof body.miles !== 'number' || body.miles < 0 || body.miles > 400) {
        return json({ error: 'miles must be between 0 and 400' }, 400)
      }
    }

    const saved = await saveDay(
      {
        date: body.date,
        kind: body.kind,
        from: body.from ?? null,
        fromCoords: body.fromCoords ?? null,
        to: body.to ?? null,
        toCoords: body.toCoords ?? null,
        miles: body.miles ?? null,
        note: body.note ?? '',
        needsReview: body.needsReview ?? false,
      },
      gate.email,
    )

    // Changing where a day ends changes where the next one starts. Off by
    // default so that correcting a distance does not quietly rewrite tomorrow.
    const next = body.rechain ? await rechainNextDay(body.date, gate.email) : null

    // A new destination has no line about it yet. Nothing is triggered from
    // here: writing one takes up to twenty-five seconds and this request is a
    // person standing in a village square holding a phone. Instead fact-warm
    // runs eight times a day and now does the destination an email is about to
    // use before anything else — an edit at nine in the evening has three runs
    // before the morning send. Changing a distance also clears the sentence
    // written about the old one, so it is rewritten rather than left wrong.
    const strip = (day: Awaited<ReturnType<typeof saveDay>> | null) =>
      day ? { ...day, routeCoords: undefined } : null

    return json({ saved: strip(saved), next: strip(next) })
  } catch (error) {
    console.error('route save failed', error)
    return json({ error: 'save failed' }, 500)
  }
}
