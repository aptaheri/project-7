import tzLookup from 'tz-lookup'
import { json } from '../lib/auth.mts'
import { db, ensureSchema } from '../lib/db.mts'
import { currentSession } from '../lib/session.mts'
import { canViewTrack, normalizeEmail } from '../lib/users.mts'
import { currentLeg } from '../lib/itinerary.mts'
import { testDevices } from '../lib/devices.mts'
import { localConditions } from '../lib/local.mts'
import type { LocalConditions } from '../lib/local.mts'
import type { CurrentLeg } from '../lib/itinerary.mts'
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
 * Fixes averaged either side when drawing the trail.
 *
 * Only the drawn line is smoothed. Distance is measured from the raw fixes, so
 * rounding off GPS wobble cannot change the reported mileage.
 */
const TRAIL_SMOOTHING = 2

/**
 * A climb is banked only once the rise exceeds this above a running reference,
 * which the descent then follows back down.
 *
 * Discriminating by amplitude rather than by frequency is the whole point:
 * a moving average wide enough to erase GPS noise also erases rolling hills,
 * because it cannot tell 8 m of jitter from a 20 m hill. Measured against
 * synthetic rides, summing raw positive deltas reported 706 m of climb on flat
 * ground and 738 m on rolling terrain whose true gain was 300 m; this reports
 * 17 m and 253 m.
 */
const GAIN_THRESHOLD_M = 5

/** Altitude is averaged over this many fixes either side before differencing. */
const ALTITUDE_SMOOTHING = 4

/** Altitudes are sampled this far apart along the route, not per fix. */
const ELEVATION_SAMPLE_M = 100

/** Fixes averaged at each end of the day to take the net change off jitter. */
const NET_ENDPOINT_FIXES = 5

/** Points in the day's elevation profile. Enough to read, small enough to poll. */
const PROFILE_POINTS = 120

/**
 * Total ascent over a series of altitudes, ignoring wobble under the threshold.
 *
 * Run here rather than in SQL because the sequential form needs a recursive CTE
 * joining an unindexed CTE, which is quadratic and would not survive the row
 * counts this table will reach.
 */
function hysteresisGain(altitudes: number[], threshold: number): number {
  let reference: number | null = null
  let gain = 0

  for (const alt of altitudes) {
    if (!Number.isFinite(alt)) continue
    if (reference === null) {
      reference = alt
      continue
    }
    if (alt > reference + threshold) {
      gain += alt - reference
      reference = alt
    } else if (alt < reference) {
      // Follow the descent down so the next climb is measured from the valley.
      reference = alt
    }
  }

  return gain
}

/** Serving a slightly stale feed beats re-scanning the table for every viewer. */
const CACHE_MS = 20_000

/**
 * How long a cached payload stays valid when no new fix has arrived.
 *
 * Compute is billed by GB-hour and covers the database as well as the
 * functions, so a poll that wakes Postgres to re-derive an unchanged answer is
 * the expensive part — not the request itself, which costs almost nothing. When
 * nobody is riding, a poll should cost one indexed lookup and nothing more.
 */
const IDLE_CACHE_MS = 5 * 60_000

/** Day summaries and the like change only as days complete, not per fix. */
const COLD_CACHE_MS = 5 * 60_000

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
  today_m: number
  points: number
  points_today: number
}

/**
 * The rider's own local day, derived from where he is rather than from the
 * server or the viewer. Riding east across a border can shift the day boundary
 * by an hour, and "today" has to mean what it means to him.
 */
function localDay(lat: number, lon: number): { zone: string; date: string } {
  let zone: string
  try {
    zone = tzLookup(lat, lon)
  } catch {
    zone = 'UTC'
  }
  // en-CA formats as YYYY-MM-DD, which Postgres casts to date directly.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date())
  return { zone, date }
}

interface TrailRow {
  lon: number
  lat: number
}

interface DaySummary {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  /** True when the day is reconstructed rather than recorded. */
  reconstructed: boolean
  distanceKm: number
  /** First fix to last fix. Includes stops, which is what was asked for. */
  elapsedSeconds: number
  fixes: number
  start: [number, number]
  end: [number, number]
  gainM: number
  netM: number | null
  highM: number | null
  lowM: number | null
}

interface Payload {
  latest: LatestRow | null
  trail: [number, number][]
  count: number
  countToday: number
  distanceKm: number
  distanceTodayKm: number
  /** IANA zone the day boundary was taken from, for labelling. */
  timezone: string | null
  elevationGainM: number
  /** Height now versus the start of his local day. Null if he has not ridden. */
  netTodayM: number | null
  /** Today's ride profile: metres travelled against smoothed altitude. */
  profileToday: { m: number; alt: number }[]
  /** One entry per riding day, oldest first. */
  days: DaySummary[]
  /** The planned leg he appears to be on, or null when nothing fits. */
  leg: CurrentLeg | null
  /** Reconstructed riding from before the tracker existed. Drawn dashed. */
  backfillTrail: [number, number][]
  backfillKm: number
  /** Sun times and weather where he is. */
  local: LocalConditions | null
  trailPoints: number
  mode: 'production' | 'test'
}

// Keyed by mode so the two views cannot serve each other's cached payload.
const cache = new Map<string, { at: number; watermark: string | null; payload: Payload }>()

/** Reconstructed riding is fixed history; it never needs recomputing. */
let backfillCache: { trail: [number, number][]; km: number } | null = null

/** Per-day summaries, which only shift when a day gains or completes. */
const dayCache = new Map<string, { at: number; days: DaySummary[] }>()

/**
 * Per-day summaries across both measured and reconstructed riding.
 *
 * Two full-history window queries, so the caller runs this on a slower clock
 * than the live position — days only shift as one gains fixes or completes.
 */
async function computeDays(
  sql: ReturnType<typeof db>,
  zone: string,
  devices: string[],
  isTest: boolean,
): Promise<DaySummary[]> {
  const dayRows = (await sql`
      with ordered as (
        select
          tst, lat, lon, source,
          (tst at time zone ${zone}::text)::date as local_date,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where ((device = any(${devices}::text[])) = ${isTest}::boolean and source = 'device')
           or source = 'backfill'
      ),
      steps as (
        select
          tst, lat, lon, local_date, source,
          case when plat is null then 0 else
            2 * 6371000 * asin(least(1, sqrt(
              power(sin(radians(lat - plat) / 2), 2) +
              cos(radians(plat)) * cos(radians(lat)) *
              power(sin(radians(lon - plon) / 2), 2)
            )))
          end as step_m
        from ordered
      ),
      totals as (
        select
          local_date,
          coalesce(sum(step_m), 0)::float8 as distance_m,
          extract(epoch from (max(tst) - min(tst)))::float8 as elapsed_s,
          count(*)::int as fixes,
          bool_or(source = 'backfill') as reconstructed
        from steps
        group by local_date
      ),
      first_fix as (
        select distinct on (local_date) local_date, lat, lon
        from steps order by local_date, tst asc
      ),
      last_fix as (
        select distinct on (local_date) local_date, lat, lon
        from steps order by local_date, tst desc
      )
      select
        to_char(t.local_date, 'YYYY-MM-DD') as date,
        t.distance_m, t.elapsed_s, t.fixes, t.reconstructed,
        f.lat as start_lat, f.lon as start_lon,
        l.lat as end_lat, l.lon as end_lon
      from totals t
      join first_fix f on f.local_date = t.local_date
      join last_fix l on l.local_date = t.local_date
      order by t.local_date
    `) as unknown as {
      date: string
      distance_m: number
      elapsed_s: number
      fixes: number
      reconstructed: boolean
      start_lat: number
      start_lon: number
      end_lat: number
      end_lon: number
    }[]

    // Altitude sampled per day, so each day's climb is measured the same way as
    // the running total rather than by a cruder shortcut.
    const dayAltRows = (await sql`
      with ordered as (
        select
          tst, lat, lon,
          (tst at time zone ${zone}::text)::date as local_date,
          avg(alt) over (
            order by tst
            rows between ${ALTITUDE_SMOOTHING} preceding and ${ALTITUDE_SMOOTHING} following
          ) as alt_s,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where (device = any(${devices}::text[])) = ${isTest}::boolean
          and source = 'device'
      ),
      steps as (
        select
          tst, local_date, alt_s,
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
        select
          tst, local_date, alt_s,
          sum(step_m) over (partition by local_date order by tst) as cum_m
        from steps
      )
      select
        to_char(local_date, 'YYYY-MM-DD') as date,
        floor(cum_m / ${ELEVATION_SAMPLE_M}::float8) as slice,
        avg(alt_s)::float8 as alt
      from cumulative
      where alt_s is not null
      group by local_date, slice
      order by local_date, slice
    `) as unknown as { date: string; slice: number; alt: number }[]

    const altsByDay = new Map<string, number[]>()
    for (const row of dayAltRows) {
      const list = altsByDay.get(row.date)
      if (list) list.push(row.alt)
      else altsByDay.set(row.date, [row.alt])
    }

  const days: DaySummary[] = dayRows.map((d) => {
      const alts = altsByDay.get(d.date) ?? []
      return {
        date: d.date,
        reconstructed: d.reconstructed,
        distanceKm: d.distance_m / 1000,
        elapsedSeconds: d.elapsed_s,
        fixes: d.fixes,
        start: [d.start_lon, d.start_lat],
        end: [d.end_lon, d.end_lat],
        gainM: hysteresisGain(alts, GAIN_THRESHOLD_M),
        netM: alts.length >= 2 ? alts[alts.length - 1] - alts[0] : null,
        highM: alts.length ? Math.max(...alts) : null,
        lowM: alts.length ? Math.min(...alts) : null,
      }
    })

  return days
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405)
  }

  const session = currentSession(req)
  if (!session) return json({ error: 'unauthorized' }, 401)

  let role: Role = 'pending'
  try {
    await ensureSchema()
    const roles = (await db()`
      select role from viewers where email = ${normalizeEmail(session.email)}
    `) as unknown as { role: Role }[]
    role = roles[0]?.role ?? 'pending'
    if (!canViewTrack(role)) {
      return json({ error: 'forbidden' }, 403)
    }
  } catch (error) {
    console.error('role check failed', error)
    return json({ error: 'query failed' }, 500)
  }

  // Test data is an owner-only view. Anyone else always gets production, no
  // matter what they put in the query string.
  const isOwner = role === 'owner'
  const wantsTest = new URL(req.url).searchParams.get('mode') === 'test'
  const mode: 'production' | 'test' = isOwner && wantsTest ? 'test' : 'production'
  const devices = testDevices()
  const isTest = mode === 'test'

  const cached = cache.get(mode)

  // The newest fix time is an index-only lookup. If it has not moved, nothing
  // downstream can have changed, so the whole payload is reused without running
  // the window-function queries that make up the real cost.
  let watermark: string | null = null
  try {
    const rows = (await db()`
      select max(tst)::text as max_tst
      from locations
      where (device = any(${devices}::text[])) = ${isTest}::boolean
        and source = 'device'
    `) as unknown as { max_tst: string | null }[]
    watermark = rows[0]?.max_tst ?? null
  } catch (error) {
    console.error('watermark lookup failed', error)
    // A cached answer beats an error if we have one.
    if (cached) return json(cached.payload)
    return json({ error: 'query failed' }, 500)
  }

  const age = cached ? Date.now() - cached.at : Infinity
  if (cached && age < CACHE_MS) return json(cached.payload)
  if (cached && cached.watermark === watermark && age < IDLE_CACHE_MS) {
    return json(cached.payload)
  }

  try {
    const sql = db()

    // `(device is in the test list) = isTest` keeps test rows in test mode and
    // everything else in production, with one comparison and no branching SQL.
    const latestRows = (await sql`
      select tst, lat, lon, acc, alt, vel, batt, bs, conn, tid
      from locations
      where (device = any(${devices}::text[])) = ${isTest}::boolean
        and source = 'device'
      order by tst desc
      limit 1
    `) as unknown as LatestRow[]

    const latest = latestRows[0] ?? null
    if (!latest) {
      const payload: Payload = {
        latest: null,
        trail: [],
        count: 0,
        countToday: 0,
        distanceKm: 0,
        distanceTodayKm: 0,
        timezone: null,
        elevationGainM: 0,
        netTodayM: null,
        profileToday: [],
        days: [],
        leg: null,
        backfillTrail: [],
        backfillKm: 0,
        local: null,
        trailPoints: 0,
        mode,
      }
      cache.set(mode, { at: Date.now(), watermark, payload })
      return json(payload)
    }

    const { zone, date: today } = localDay(latest.lat, latest.lon)

    // Distance is measured over every stored fix, not the thinned trail, so
    // thinning changes what is drawn but never what is reported.
    const statsRows = (await sql`
      with ordered as (
        select
          tst, lat, lon,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where (device = any(${devices}::text[])) = ${isTest}::boolean
          and source = 'device'
      ),
      steps as (
        select
          -- The day is bucketed in the rider's own timezone, so "today" means
          -- his day rather than the server's or the viewer's.
          (tst at time zone ${zone}::text)::date as local_date,
          case when plat is null then 0 else
            2 * 6371000 * asin(least(1, sqrt(
              power(sin(radians(lat - plat) / 2), 2) +
              cos(radians(plat)) * cos(radians(lat)) *
              power(sin(radians(lon - plon) / 2), 2)
            )))
          end as step_m
        from ordered
      )
      select
        coalesce(sum(step_m), 0)::float8 as distance_m,
        coalesce(sum(step_m) filter (where local_date = ${today}::date), 0)::float8 as today_m,
        count(*)::int as points,
        count(*) filter (where local_date = ${today}::date)::int as points_today
      from steps
    `) as unknown as StatsRow[]

    const stats = statsRows[0] ?? { distance_m: 0, today_m: 0, points: 0, points_today: 0 }

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
          avg(lat) over (
            order by tst
            rows between ${TRAIL_SMOOTHING} preceding and ${TRAIL_SMOOTHING} following
          ) as lat_s,
          avg(lon) over (
            order by tst
            rows between ${TRAIL_SMOOTHING} preceding and ${TRAIL_SMOOTHING} following
          ) as lon_s,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where (device = any(${devices}::text[])) = ${isTest}::boolean
          and source = 'device'
      ),
      steps as (
        select
          tst, lat_s, lon_s,
          case when plat is null then 0 else
            2 * 6371000 * asin(least(1, sqrt(
              power(sin(radians(lat - plat) / 2), 2) +
              cos(radians(plat)) * cos(radians(lat)) *
              power(sin(radians(lon - plon) / 2), 2)
            )))
          end as step_m
        from ordered
      ),
      bucketed as (
        -- The slice index is computed once and referenced by name. Interpolating
        -- the spacing twice would emit two different placeholders, and Postgres
        -- rejects a DISTINCT ON whose expression does not textually match the
        -- leading ORDER BY.
        select
          tst, lat_s, lon_s,
          floor(sum(step_m) over (order by tst) / ${spacing}::float8) as slice
        from steps
      ),
      thinned as (
        select distinct on (slice) tst, lat_s, lon_s
        from bucketed
        order by slice, tst
      )
      select lon_s as lon, lat_s as lat from thinned order by tst
    `) as unknown as TrailRow[]

    // Altitude sampled by distance travelled rather than per fix, so the series
    // stays proportional to route length instead of to how often the phone
    // reported, and hysteresis sees hills rather than jitter.
    //
    // Scoped to his local day, like every other figure in this section. Without
    // the date filter this was every foot he had climbed since Lisbon, sitting
    // under a label that said "today".
    const elevationRows = (await sql`
      with ordered as (
        select
          tst, lat, lon,
          avg(alt) over (
            order by tst
            rows between ${ALTITUDE_SMOOTHING} preceding and ${ALTITUDE_SMOOTHING} following
          ) as alt_s,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where (device = any(${devices}::text[])) = ${isTest}::boolean
          and source = 'device'
          and (tst at time zone ${zone}::text)::date = ${today}::date
      ),
      steps as (
        select
          tst, alt_s,
          case when plat is null then 0 else
            2 * 6371000 * asin(least(1, sqrt(
              power(sin(radians(lat - plat) / 2), 2) +
              cos(radians(plat)) * cos(radians(lat)) *
              power(sin(radians(lon - plon) / 2), 2)
            )))
          end as step_m
        from ordered
      ),
      sampled as (
        select
          floor(sum(step_m) over (order by tst) / ${ELEVATION_SAMPLE_M}::float8) as slice,
          alt_s
        from steps
      )
      select slice, avg(alt_s)::float8 as alt
      from sampled
      where alt_s is not null
      group by slice
      order by slice
    `) as unknown as { slice: number; alt: number }[]

    const elevationGainM = hysteresisGain(
      elevationRows.map((r) => r.alt),
      GAIN_THRESHOLD_M,
    )

    // Net change is deliberately end-minus-start rather than accumulated: it
    // answers "is he higher than this morning", which cumulative gain cannot,
    // and averaging both ends makes it immune to the jitter that made gain hard.
    const netRows = (await sql`
      with today_fixes as (
        select tst, alt
        from locations
        where (device = any(${devices}::text[])) = ${isTest}::boolean
          and source = 'device'
          and (tst at time zone ${zone}::text)::date = ${today}::date
          and alt is not null
      )
      select (
        (select avg(alt) from (select alt from today_fixes order by tst desc limit ${NET_ENDPOINT_FIXES}) l)
        -
        (select avg(alt) from (select alt from today_fixes order by tst asc limit ${NET_ENDPOINT_FIXES}) f)
      )::float8 as net_m
    `) as unknown as { net_m: number | null }[]

    const netTodayM = netRows[0]?.net_m ?? null

    // The day's profile, thinned to a fixed number of points so the payload
    // stays the same size whether he rode 5 miles or 150.
    const profileSpacing = Math.max(50, stats.today_m / PROFILE_POINTS)
    const profileRows = (await sql`
      with ordered as (
        select
          tst, lat, lon,
          avg(alt) over (
            order by tst
            rows between ${ALTITUDE_SMOOTHING} preceding and ${ALTITUDE_SMOOTHING} following
          ) as alt_s,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where (device = any(${devices}::text[])) = ${isTest}::boolean
          and source = 'device'
          and (tst at time zone ${zone}::text)::date = ${today}::date
      ),
      steps as (
        select
          tst, alt_s,
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
        select tst, alt_s, sum(step_m) over (order by tst) as cum_m from steps
      ),
      sampled as (
        select
          floor(cum_m / ${profileSpacing}::float8) as slice,
          max(cum_m)::float8 as m,
          avg(alt_s)::float8 as alt
        from cumulative
        where alt_s is not null
        group by 1
      )
      select m, alt from sampled order by slice
    `) as unknown as { m: number; alt: number }[]

    // --- Per-day summaries -------------------------------------------------
    const dayKey = `${mode}:${zone}`
    const cachedDays = dayCache.get(dayKey)
    const days =
      cachedDays && Date.now() - cachedDays.at < COLD_CACHE_MS
        ? cachedDays.days
        : await computeDays(sql, zone, devices, isTest)
    if (days !== cachedDays?.days) dayCache.set(dayKey, { at: Date.now(), days })

    // Reconstructed riding never changes, so it is derived once per instance
    // rather than re-queried behind every poll.
    if (!backfillCache) {
      const backfillRows = (await sql`
        with ordered as (
          select
            tst, lat, lon,
            lag(lat) over (order by tst) as plat,
            lag(lon) over (order by tst) as plon
          from locations
          where source = 'backfill'
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
        )
        select lon, lat, sum(step_m) over () as total_m from steps order by tst
      `) as unknown as { lon: number; lat: number; total_m: number }[]

      backfillCache = {
        trail: backfillRows.map((r) => [r.lon, r.lat]),
        km: (backfillRows[0]?.total_m ?? 0) / 1000,
      }
    }
    const backfillTrail = backfillCache.trail
    const backfillKm = backfillCache.km

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
      countToday: stats.points_today,
      distanceKm: stats.distance_m / 1000,
      distanceTodayKm: stats.today_m / 1000,
      timezone: zone,
      elevationGainM,
      netTodayM,
      profileToday: profileRows,
      days,
      leg: currentLeg([latest.lon, latest.lat], today),
      backfillTrail,
      backfillKm,
      local: await localConditions(latest.lat, latest.lon),
      trailPoints: trail.length,
      mode,
    }

    cache.set(mode, { at: Date.now(), watermark, payload })
    return json(payload)
  } catch (error) {
    console.error('track feed failed', error)
    return json({ error: 'query failed' }, 500)
  }
}
