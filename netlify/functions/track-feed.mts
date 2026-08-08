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

/** Roughly how many points the drawn trail should contain, at any route length. */
const TARGET_TRAIL_POINTS = 2000

/** Never thin below this, so short rides keep their shape. */
const MIN_SPACING_M = 25

/**
 * GPS altitude jitters by a few metres even standing still. Without a floor,
 * summing every positive delta invents thousands of metres of fictional climb.
 */
const GAIN_THRESHOLD_M = 3

/** Serving a slightly stale feed beats re-scanning the table for every viewer. */
const CACHE_MS = 20_000

interface LatestRow {
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

interface StatsRow {
  distance_m: number
  gain_m: number
  points: number
}

interface TrailRow {
  lon: number
  lat: number
}

interface Payload {
  latest: LatestRow | null
  trail: [number, number][]
  count: number
  distanceKm: number
  elevationGainM: number
  trailPoints: number
}

let cache: { at: number; payload: Payload } | null = null

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

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return json(cache.payload)
  }

  try {
    const sql = db()

    const latestRows = (await sql`
      select tst, lat, lon, acc, alt, vel, batt, bs, conn, tid
      from locations
      order by tst desc
      limit 1
    `) as unknown as LatestRow[]

    const latest = latestRows[0] ?? null
    if (!latest) {
      const payload: Payload = {
        latest: null,
        trail: [],
        count: 0,
        distanceKm: 0,
        elevationGainM: 0,
        trailPoints: 0,
      }
      cache = { at: Date.now(), payload }
      return json(payload)
    }

    // Distance and climb are measured over every stored fix, not the thinned
    // trail, so thinning changes what is drawn but never what is reported.
    const statsRows = (await sql`
      with ordered as (
        select
          lat, lon, alt,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon,
          lag(alt) over (order by tst) as palt
        from locations
      ),
      steps as (
        select
          case when plat is null then 0 else
            2 * 6371000 * asin(least(1, sqrt(
              power(sin(radians(lat - plat) / 2), 2) +
              cos(radians(plat)) * cos(radians(lat)) *
              power(sin(radians(lon - plon) / 2), 2)
            )))
          end as step_m,
          case
            when palt is null or alt is null then 0
            when alt - palt > ${GAIN_THRESHOLD_M} then alt - palt
            else 0
          end as gain_m
        from ordered
      )
      select
        coalesce(sum(step_m), 0)::float8 as distance_m,
        coalesce(sum(gain_m), 0)::float8 as gain_m,
        count(*)::int as points
      from steps
    `) as unknown as StatsRow[]

    const stats = statsRows[0] ?? { distance_m: 0, gain_m: 0, points: 0 }

    // Spacing scales with the route so the payload stays flat whether he has
    // ridden 10 km or 50,000.
    const spacing = Math.max(MIN_SPACING_M, stats.distance_m / TARGET_TRAIL_POINTS)

    // Take the first fix in each fixed-length slice of the travelled path.
    // Thinning by distance rather than by row count keeps the shape of the
    // route intact and drops only the points where he was barely moving.
    const trailRows = (await sql`
      with ordered as (
        select
          tst, lat, lon,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
      ),
      steps as (
        select
          tst, lat, lon,
          case when plat is null then 0 else
            2 * 6371000 * asin(least(1, sqrt(
              power(sin(radians(lat - plat) / 2), 2) +
              cos(radians(plat)) * cos(radians(lat)) *
              power(sin(radians(lon - plon) / 2), 2)
            )))
          end as step_m
        from ordered
      ),
      cumulative as (
        select tst, lat, lon, sum(step_m) over (order by tst) as cum_m
        from steps
      ),
      thinned as (
        select distinct on (floor(cum_m / ${spacing})) tst, lat, lon
        from cumulative
        order by floor(cum_m / ${spacing}), tst
      )
      select lon, lat from thinned order by tst
    `) as unknown as TrailRow[]

    const trail: [number, number][] = trailRows.map((r) => [r.lon, r.lat])

    // The newest fix can fall inside an already-represented slice, which would
    // leave the drawn line stopping short of the marker.
    const tail = trail[trail.length - 1]
    if (!tail || tail[0] !== latest.lon || tail[1] !== latest.lat) {
      trail.push([latest.lon, latest.lat])
    }

    const payload: Payload = {
      latest,
      trail,
      count: stats.points,
      distanceKm: stats.distance_m / 1000,
      elevationGainM: stats.gain_m,
      trailPoints: trail.length,
    }

    cache = { at: Date.now(), payload }
    return json(payload)
  } catch (error) {
    console.error('track feed failed', error)
    return json({ error: 'query failed' }, 500)
  }
}
