import { checkBasicAuth } from '../lib/auth.mts'
import { db, ensureSchema } from '../lib/db.mts'

/**
 * Ingest endpoint for the OwnTracks phone app (Mode = HTTP).
 *
 * The app expects a JSON array in response — anything else and it treats the
 * delivery as failed and re-queues the point. The array can carry messages back
 * to the device; we have nothing to say, so it is always empty.
 */

interface OwnTracksMessage {
  _type?: string
  lat?: unknown
  lon?: unknown
  tst?: unknown
  acc?: unknown
  alt?: unknown
  vel?: unknown
  cog?: unknown
  batt?: unknown
  bs?: unknown
  conn?: unknown
  tid?: unknown
  topic?: unknown
}

// A fresh Response per call — a shared instance can only have its body read
// once, so reusing one breaks every request after the first on a warm instance.
function ack(): Response {
  return new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
    })
  }

  const denied = checkBasicAuth(req)
  if (denied) return denied

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Single object normally; an array when the app flushes a backlog.
  const messages: OwnTracksMessage[] = Array.isArray(body)
    ? (body as OwnTracksMessage[])
    : [body as OwnTracksMessage]

  const points = messages.filter((m) => m?._type === 'location')
  // Acknowledge transitions, waypoints and lwt without storing them.
  if (points.length === 0) return ack()

  try {
    await ensureSchema()
    const sql = db()

    for (const m of points) {
      const lat = num(m.lat)
      const lon = num(m.lon)
      const tst = num(m.tst)

      // A fix without coordinates or a timestamp is unusable. Skip rather than
      // fail the batch, so one bad point cannot block the rest.
      if (lat === null || lon === null || tst === null) continue
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue

      const device = str(m.topic) ?? str(m.tid) ?? 'unknown'
      const fixedAt = new Date(tst * 1000)
      if (Number.isNaN(fixedAt.getTime())) continue

      await sql`
        insert into locations (device, tst, lat, lon, acc, alt, vel, cog, batt, bs, conn, tid, raw)
        values (
          ${device}, ${fixedAt.toISOString()}, ${lat}, ${lon},
          ${num(m.acc)}, ${num(m.alt)}, ${num(m.vel)}, ${num(m.cog)},
          ${num(m.batt)}, ${num(m.bs)}, ${str(m.conn)}, ${str(m.tid)},
          ${JSON.stringify(m)}
        )
        on conflict (device, tst) do nothing
      `
    }
  } catch (error) {
    console.error('owntracks ingest failed', error)
    // 5xx makes the phone retry, so the point is not lost.
    return new Response(JSON.stringify({ error: 'storage failure' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  return ack()
}
