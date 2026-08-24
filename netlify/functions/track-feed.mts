import tzLookup from 'tz-lookup'
import { json } from '../lib/auth.mts'
import { db } from '../lib/db.mts'
import { requireTrackViewer } from '../lib/gate.mts'
import { currentLeg, daysFromPlan } from '../lib/itinerary.mts'
import { lineForMap, loadRoute } from '../lib/route.mts'
import { testDevices } from '../lib/devices.mts'
import { localDayRange } from '../lib/day.mts'
import {
  ALTITUDE_SMOOTHING,
  ELEVATION_SAMPLE_M,
  GAIN_THRESHOLD_M,
  TRAIL_SMOOTHING,
  hysteresisGain,
  loadTotals,
} from '../lib/rollups.mts'
import type { DaySummary } from '../lib/rollups.mts'
import { localConditions } from '../lib/local.mts'
import type { LocalConditions } from '../lib/local.mts'
import type { CurrentLeg } from '../lib/itinerary.mts'

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

/** Fixes averaged at each end of the day to take the net change off jitter. */
const NET_ENDPOINT_FIXES = 5

/** Points in the day's elevation profile. Enough to read, small enough to poll. */
const PROFILE_POINTS = 120

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
  /**
   * Today's ride so far, as a day summary. Finished days live behind
   * /api/track/history, which changes once a day rather than once a fix.
   */
  today: DaySummary | null
  /** Changes only when the stored history does; the client refetches on it. */
  historyVersion: string
  /**
   * Always empty. Kept for one release only.
   *
   * A viewer with the tracker already open goes on running the previous
   * bundle until they reload, and that one reads these fields directly. Absent,
   * it throws and they get an error page instead of a map; empty, it draws a
   * little less than it should until the next reload. Delete these after a
   * deploy or two — nothing this side reads them.
   */
  days: never[]
  backfillTrail: never[]
  backfillKm: number
  /** The planned leg he appears to be on, or null when nothing fits. */
  leg: CurrentLeg | null
  /**
   * The roads he means to ride today, if the day has been routed. Drawn ahead
   * of him on the map. Null on a rest day, or a day nobody has routed.
   */
  plannedRoute: [number, number][] | null
  /** Sun times and weather where he is. */
  local: LocalConditions | null
  trailPoints: number
  mode: 'production' | 'test'
}

// Keyed by mode so the two views cannot serve each other's cached payload.
const cache = new Map<string, { at: number; watermark: string | null; payload: Payload }>()

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return json({ error: 'method not allowed' }, 405)
  }

  const gate = await requireTrackViewer(req)
  if (gate instanceof Response) return gate

  // Test data is an owner-only view. Anyone else always gets production, no
  // matter what they put in the query string.
  const isOwner = gate.role === 'owner'
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
        today: null,
        historyVersion: 'empty',
        plannedRoute: null,
        days: [],
        backfillTrail: [],
        backfillKm: 0,
        leg: null,
        local: null,
        trailPoints: 0,
        mode,
      }
      cache.set(mode, { at: Date.now(), watermark, payload })
      return json(payload)
    }

    const { zone, date: today } = localDay(latest.lat, latest.lon)
    // His day as a range of instants, which is the form an index can answer.
    const { start: dayStart, end: dayEnd } = localDayRange(zone, today)

    // Distance is measured over every stored fix, not the thinned trail, so
    // thinning changes what is drawn but never what is reported.
    // Everything before today, read back as numbers. This is the change that
    // stops the feed getting more expensive every week: the fixes behind these
    // totals are only read again when a day ends or fixes arrive late for one
    // that already has.
    const rollups = await loadTotals({
      sql, zone, mode, devices, isTest, todayStart: dayStart, today,
    })

    // Today, and only today. Bounded by an instant range rather than by
    // `(tst at time zone $zone)::date = $today`, which wraps the column in a
    // function call and so cannot use the index on tst — that one detail meant
    // every "today" query was reading the whole table and discarding the rest.
    const statsRows = (await sql`
      with window_rows as (
        -- The last fix before midnight, borrowed so the first step of the day is
        -- measured from where he actually stopped. Without it the distance from
        -- his last fix last night to his first this morning would go uncounted,
        -- and the trip total would quietly shrink by one step per day against
        -- the figure that has been reported all along. One row, by index.
        (
          select tst, lat, lon from locations
          where (device = any(${devices}::text[])) = ${isTest}::boolean
            and source = 'device'
            and tst < ${dayStart.toISOString()}::timestamptz
          order by tst desc
          limit 1
        )
        union all
        (
          select tst, lat, lon from locations
          where (device = any(${devices}::text[])) = ${isTest}::boolean
            and source = 'device'
            and tst >= ${dayStart.toISOString()}::timestamptz
            and tst < ${dayEnd.toISOString()}::timestamptz
        )
      ),
      ordered as (
        select
          tst, lat, lon,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from window_rows
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
        where tst >= ${dayStart.toISOString()}::timestamptz
      )
      -- Everything today's summary needs, from the one scan: how far, how many,
      -- how long, and where he set off from.
      select
        coalesce(sum(step_m), 0)::float8 as today_m,
        count(*)::int as points_today,
        coalesce(extract(epoch from (max(tst) - min(tst))), 0)::float8 as elapsed_s,
        (array_agg(lat order by tst asc))[1]::float8 as start_lat,
        (array_agg(lon order by tst asc))[1]::float8 as start_lon
      from steps
    `) as unknown as {
      today_m: number
      points_today: number
      elapsed_s: number
      start_lat: number | null
      start_lon: number | null
    }[]

    const todayStats = statsRows[0] ?? {
      today_m: 0,
      points_today: 0,
      elapsed_s: 0,
      start_lat: null,
      start_lon: null,
    }

    // The first fix of the day has no predecessor inside the day, so the step
    // from where he stopped yesterday is not counted against today. That is the
    // same arithmetic as before, where the window ran over everything and the
    // day boundary fell between two rows.
    const stats = {
      distance_m: rollups.distanceM + todayStats.today_m,
      today_m: todayStats.today_m,
      points: rollups.fixes + todayStats.points_today,
      points_today: todayStats.points_today,
    }

    // Today's line, at the same spacing the whole route is drawn at, so the
    // join between the stored history and today is invisible.
    const spacing = Math.max(MIN_SPACING_M, stats.distance_m / TARGET_TRAIL_POINTS)

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
          and tst >= ${dayStart.toISOString()}::timestamptz
          and tst < ${dayEnd.toISOString()}::timestamptz
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
          and tst >= ${dayStart.toISOString()}::timestamptz
          and tst < ${dayEnd.toISOString()}::timestamptz
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
          and tst >= ${dayStart.toISOString()}::timestamptz
          and tst < ${dayEnd.toISOString()}::timestamptz
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
          and tst >= ${dayStart.toISOString()}::timestamptz
          and tst < ${dayEnd.toISOString()}::timestamptz
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
    // Finished days come back as stored numbers; today is assembled from the
    // figures already computed above, which cost one indexed range scan.
    const todayAlts = elevationRows.map((r) => r.alt)
    const todaySummary: DaySummary | null = todayStats.points_today
      ? {
          date: today,
          reconstructed: false,
          distanceKm: todayStats.today_m / 1000,
          elapsedSeconds: todayStats.elapsed_s,
          fixes: todayStats.points_today,
          start:
            todayStats.start_lon !== null && todayStats.start_lat !== null
              ? [todayStats.start_lon, todayStats.start_lat]
              : [latest.lon, latest.lat],
          end: [latest.lon, latest.lat],
          gainM: elevationGainM,
          netM: netTodayM,
          highM: todayAlts.length ? Math.max(...todayAlts) : null,
          lowM: todayAlts.length ? Math.min(...todayAlts) : null,
        }
      : null
    // Finished days and the line through them now come from /api/track/history,
    // fetched once a session. Only today rides along with the live figures.

    // Today's line only. The client already holds the history and draws the two
    // together, so the ~1 MB of route behind him is not re-sent every thirty
    // seconds to move a marker a few hundred metres.
    const trail: [number, number][] = trailRows.map((r) => [r.lon, r.lat])

    // Matched against the route as it now stands rather than the plan, so a
    // reroute he entered last night shows up here. Drift is still measured
    // against the plan — see daysFromPlan.
    const route = await loadRoute()
    const legNow = currentLeg([latest.lon, latest.lat], today, route)
    const behind = daysFromPlan([latest.lon, latest.lat], today)

    // The roads he means to ride today, when we know them. Drawn ahead of him
    // on the map, which is the question everyone actually asks of a tracker:
    // not where has he been, but where is he going.
    // Thinned before it goes on the wire: at full detail one day is seventeen
    // kilobytes, which is five times the rest of this payload put together.
    const plannedFull = route.find((d) => d.date === today)?.routeCoords ?? null
    const plannedToday = plannedFull?.length ? lineForMap(plannedFull) : null

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
      today: todaySummary,
      historyVersion: rollups.version,
      days: [],
      backfillTrail: [],
      backfillKm: 0,
      leg: legNow ? { ...legNow, daysFromSchedule: behind ?? legNow.daysFromSchedule } : null,
      plannedRoute: plannedToday,
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
