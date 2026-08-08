import { json } from '../lib/auth.mts'
import { db, ensureSchema } from '../lib/db.mts'
import { currentSession } from '../lib/session.mts'
import { canViewTrack, normalizeEmail } from '../lib/users.mts'
import type { Role } from '../lib/session.mts'

/**
 * Read endpoint backing the /track page.
 *
 * Requires a signed-in Google account holding the owner or viewer role. The
 * role is read fresh on every request rather than trusted from the cookie, so
 * revoking someone takes effect on their next poll.
 */

const DEFAULT_LIMIT = 1000
const MAX_LIMIT = 5000

interface Row {
  tst: string
  lat: number
  lon: number
  acc: number | null
  alt: number | null
  vel: number | null
  batt: number | null
  bs: number | null
  conn: string | null
  tid: string | null
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405)
  }

  const session = currentSession(req)
  if (!session) return json({ error: 'unauthorized' }, 401)

  try {
    await ensureSchema()
    const roles = (await db()`
      select role from viewers where email = ${normalizeEmail(session.email)}
    `) as unknown as { role: Role }[]
    if (!canViewTrack(roles[0]?.role ?? 'pending')) {
      return json({ error: 'forbidden' }, 403)
    }
  } catch (error) {
    console.error('role check failed', error)
    return json({ error: 'query failed' }, 500)
  }

  const url = new URL(req.url)
  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_LIMIT)
    : DEFAULT_LIMIT

  try {
    await ensureSchema()
    const sql = db()

    const rows = (await sql`
      select tst, lat, lon, acc, alt, vel, batt, bs, conn, tid
      from locations
      order by tst desc
      limit ${limit}
    `) as unknown as Row[]

    if (rows.length === 0) {
      return json({ latest: null, trail: [], count: 0 })
    }

    // Newest first from the query; the map wants the trail in travel order.
    const chronological = [...rows].reverse()

    return json({
      latest: rows[0],
      trail: chronological.map((r) => [r.lon, r.lat]),
      count: rows.length,
    })
  } catch (error) {
    console.error('track feed failed', error)
    return json({ error: 'query failed' }, 500)
  }
}
