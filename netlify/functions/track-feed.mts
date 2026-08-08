import { json, secretsMatch } from '../lib/auth.mts'
import { db, ensureSchema } from '../lib/db.mts'

/**
 * Read endpoint backing the /track page.
 *
 * Gated by a shared token in the query string rather than Basic auth, so the
 * page can be opened from a bookmark without a credential prompt. The token is
 * the only thing keeping the feed private — treat the URL as a secret.
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

  const expected = process.env.OWNTRACKS_VIEW_TOKEN
  if (!expected) {
    console.error('OWNTRACKS_VIEW_TOKEN is not configured')
    return json({ error: 'server not configured' }, 500)
  }

  const url = new URL(req.url)
  const key = url.searchParams.get('key') ?? ''
  if (!secretsMatch(key, expected)) {
    return json({ error: 'unauthorized' }, 401)
  }

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
