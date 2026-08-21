import type { db } from './db.mts'
import { localMidnightUtc } from './day.mts'


/**
 * Finished days, summarised once instead of re-derived on every poll.
 *
 * The live feed used to answer every request by reading the whole locations
 * table — six window-function passes over every fix ever recorded, once per
 * arriving fix. That is a cost that grows with the length of the trip, on a
 * database billed by the hour it stays awake: by Antarctica each poll would
 * have been sifting half a million rows to redraw a line that had not changed
 * since Portugal.
 *
 * Yesterday cannot change. So each day is summarised when it ends, stored, and
 * read back as numbers; only today is computed from fixes. The work per poll
 * then depends on how far he has ridden today, not on how far he has ridden.
 *
 * The summaries are produced by running the original queries unchanged, just
 * far less often. That is deliberate: a faster query rewritten for this would
 * have been a second implementation of the distance and climb arithmetic, free
 * to disagree with the first, and the numbers it produces are ones John reads
 * every morning and compares against his bike computer.
 */

/** A climb is banked only once the rise exceeds this above a running reference. */
export const GAIN_THRESHOLD_M = 5

/** Altitude is averaged over this many fixes either side before differencing. */
export const ALTITUDE_SMOOTHING = 4

/** Altitudes are sampled this far apart along the route, not per fix. */
export const ELEVATION_SAMPLE_M = 100

/** Fixes averaged either side when drawing the trail. */
export const TRAIL_SMOOTHING = 2

/**
 * Total ascent over a series of altitudes, ignoring wobble under the threshold.
 *
 * Run here rather than in SQL because the sequential form needs a recursive CTE
 * joining an unindexed CTE, which is quadratic and would not survive the row
 * counts this table will reach.
 */
export function hysteresisGain(altitudes: number[], threshold: number): number {
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

export interface DaySummary {
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

type Sql = ReturnType<typeof db>

export interface RollupContext {
  sql: Sql
  /** IANA zone the day boundaries are taken from. */
  zone: string
  mode: 'production' | 'test'
  devices: string[]
  isTest: boolean
  /** First instant of the rider's today, in UTC. Everything before it is sealed. */
  todayStart: Date
  /** His local date, YYYY-MM-DD. */
  today: string
}

export interface Rollups {
  days: DaySummary[]
  /** Metres ridden across every finished day, measured and reconstructed. */
  distanceM: number
  /** Fixes recorded across every finished day. */
  fixes: number
  /** The drawn line through the end of the last finished day. */
  trail: [number, number][]
}

interface RollupRow {
  date: string
  distance_m: number
  elapsed_s: number
  fixes: number
  start_lon: number
  start_lat: number
  end_lon: number
  end_lat: number
  gain_m: number
  net_m: number | null
  high_m: number | null
  low_m: number | null
  reconstructed: boolean
}

function toSummary(row: RollupRow): DaySummary {
  return {
    date: row.date,
    reconstructed: row.reconstructed,
    distanceKm: row.distance_m / 1000,
    elapsedSeconds: row.elapsed_s,
    fixes: row.fixes,
    start: [row.start_lon, row.start_lat],
    end: [row.end_lon, row.end_lat],
    gainM: row.gain_m,
    netM: row.net_m,
    highM: row.high_m,
    lowM: row.low_m,
  }
}

/**
 * Whether the stored summaries still describe the fixes on file.
 *
 * Two ways they stop doing so: a day ends, or fixes arrive for a day already
 * summarised — which happens whenever the phone replays what it queued during a
 * gap in coverage, and every time reconstructed riding is imported. Both are
 * checked with indexed lookups, so the answer "nothing has changed" costs
 * almost nothing, which is the answer on all but one poll a day.
 */
async function needsRefresh(ctx: RollupContext): Promise<boolean> {
  const { sql, mode, todayStart } = ctx

  const state = (await sql`
    select
      to_char(max(local_date), 'YYYY-MM-DD') as through,
      count(*)::int as days,
      (select zone from day_rollups where mode = ${mode} order by local_date desc limit 1) as zone
    from day_rollups where mode = ${mode}
  `) as unknown as { through: string | null; days: number; zone: string | null }[]

  const cache = (await sql`
    select to_char(through_date, 'YYYY-MM-DD') as through_date, seen_received::text as seen
    from trail_cache where mode = ${mode}
  `) as unknown as { through_date: string; seen: string }[]

  // Nothing stored yet, or the two halves disagree about how far they reach.
  if (state[0]?.days === 0 || !cache[0]) return true
  if (state[0]?.through !== cache[0].through_date) return true

  // He has crossed into a different timezone since these were computed. Day
  // boundaries fall at different instants there, so the sealed days no longer
  // meet today where today now begins: riding east moves the start of today
  // earlier in real terms, and fixes either side of the old boundary would be
  // counted once in a stored day and again in today. Re-bucketing the history
  // in the zone he is now in is what the feed did on every single poll before
  // any of this existed, so this is the old behaviour, at the moment it matters.
  if (state[0]?.zone !== ctx.zone) return true

  // Is there a finished day whose fixes landed after we last looked?
  const late = (await sql`
    select 1 from locations
    where received_at > ${cache[0].seen}::timestamptz
      and tst < ${todayStart.toISOString()}::timestamptz
    limit 1
  `) as unknown as unknown[]
  if (late.length > 0) return true

  // Has a day ended since? Asked as "is there a fix after the end of the last
  // day we summarised", which is a range the index can answer — the same trap
  // this whole change exists to remove.
  const dayAfterThrough = new Date(Date.parse(`${cache[0].through_date}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10)
  const sealedFrom = localMidnightUtc(ctx.zone, dayAfterThrough)
  if (sealedFrom >= todayStart) return false

  const sealed = (await sql`
    select 1 from locations
    where tst >= ${sealedFrom.toISOString()}::timestamptz
      and tst < ${todayStart.toISOString()}::timestamptz
    limit 1
  `) as unknown as unknown[]
  return sealed.length > 0
}

/**
 * Recomputes every finished day from the fixes themselves.
 *
 * Deliberately the whole history rather than only the days that changed: it
 * runs about once a day, the queries are the ones that were already trusted,
 * and a partial rebuild would need its own reasoning about which days a
 * replayed batch of fixes touches. Cheap enough to be dull, rare enough not to
 * matter.
 */
async function rebuild(ctx: RollupContext): Promise<void> {
  const { sql, zone, mode, devices, isTest, todayStart } = ctx
  const before = todayStart.toISOString()

  const dayRows = (await sql`
      with ordered as (
        select
          tst, lat, lon, source,
          (tst at time zone ${zone}::text)::date as local_date,
          lag(lat) over (order by tst) as plat,
          lag(lon) over (order by tst) as plon
        from locations
        where tst < ${before}::timestamptz
          and (((device = any(${devices}::text[])) = ${isTest}::boolean and source = 'device')
               or source = 'backfill')
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
        where tst < ${before}::timestamptz
          and (device = any(${devices}::text[])) = ${isTest}::boolean
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

  for (const d of dayRows) {
    const alts = altsByDay.get(d.date) ?? []
    await sql`
      insert into day_rollups (
        local_date, mode, zone, distance_m, elapsed_s, fixes,
        start_lon, start_lat, end_lon, end_lat,
        gain_m, net_m, high_m, low_m, reconstructed, computed_at
      ) values (
        ${d.date}::date, ${mode}, ${zone}, ${d.distance_m}, ${d.elapsed_s}, ${d.fixes},
        ${d.start_lon}, ${d.start_lat}, ${d.end_lon}, ${d.end_lat},
        ${hysteresisGain(alts, GAIN_THRESHOLD_M)},
        ${alts.length >= 2 ? alts[alts.length - 1] - alts[0] : null},
        ${alts.length ? Math.max(...alts) : null},
        ${alts.length ? Math.min(...alts) : null},
        ${d.reconstructed}, now()
      )
      on conflict (local_date, mode) do update set
        zone = excluded.zone,
        distance_m = excluded.distance_m,
        elapsed_s = excluded.elapsed_s,
        fixes = excluded.fixes,
        start_lon = excluded.start_lon, start_lat = excluded.start_lat,
        end_lon = excluded.end_lon, end_lat = excluded.end_lat,
        gain_m = excluded.gain_m, net_m = excluded.net_m,
        high_m = excluded.high_m, low_m = excluded.low_m,
        reconstructed = excluded.reconstructed,
        computed_at = now()
    `
  }

  // A day that no longer has fixes — the only way being a deletion — should not
  // linger in the totals.
  const keep = dayRows.map((d) => d.date)
  await sql`
    delete from day_rollups
    where mode = ${mode}
      and local_date < ${before}::timestamptz
      and to_char(local_date, 'YYYY-MM-DD') <> all(${keep}::text[])
  `

  await rebuildTrail(ctx)
}

/** Thinning target for the stored history line. Today's fixes are added live. */
const HISTORY_TRAIL_POINTS = 1500
const MIN_SPACING_M = 25

/**
 * The drawn line for everything before today, thinned once and stored.
 *
 * Thinning by distance rather than by row count keeps the shape of the route
 * intact and drops only the points where he was barely moving.
 */
async function rebuildTrail(ctx: RollupContext): Promise<void> {
  const { sql, mode, devices, isTest, todayStart, today } = ctx
  const before = todayStart.toISOString()

  const totals = (await sql`
    select coalesce(sum(distance_m), 0)::float8 as distance_m
    from day_rollups where mode = ${mode}
  `) as unknown as { distance_m: number }[]

  const spacing = Math.max(MIN_SPACING_M, (totals[0]?.distance_m ?? 0) / HISTORY_TRAIL_POINTS)

  const rows = (await sql`
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
      where tst < ${before}::timestamptz
        and (device = any(${devices}::text[])) = ${isTest}::boolean
        and source = 'device'
    ),
    steps as (
      select
        tst, lat_s, lon_s,
        case when plat is null then 0 else
          2 * 6371000 * asin(least(1, sqrt(
            power(sin(radians(lat_s - plat) / 2), 2) +
            cos(radians(plat)) * cos(radians(lat_s)) *
            power(sin(radians(lon_s - plon) / 2), 2)
          )))
        end as step_m
      from ordered
    ),
    bucketed as (
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
  `) as unknown as { lon: number; lat: number }[]

  const seen = (await sql`
    select coalesce(max(received_at), now())::text as seen from locations
    where tst < ${before}::timestamptz
  `) as unknown as { seen: string }[]

  const points = rows.map((r) => [r.lon, r.lat])
  // Yesterday, in his local reckoning: the last day the stored line covers.
  const throughDate = new Date(todayStart.getTime() - 1)

  await sql`
    insert into trail_cache (mode, through_date, points, seen_received, computed_at)
    values (
      ${mode},
      coalesce((select max(local_date) from day_rollups where mode = ${mode}), ${today}::date - 1),
      ${JSON.stringify(points)}::jsonb,
      ${seen[0]?.seen ?? throughDate.toISOString()}::timestamptz,
      now()
    )
    on conflict (mode) do update set
      through_date = excluded.through_date,
      points = excluded.points,
      seen_received = excluded.seen_received,
      computed_at = now()
  `
}

/**
 * Every finished day, refreshing the stored summaries first if they have gone
 * stale. The refresh is the only thing here that reads the fixes themselves.
 */
export async function loadRollups(ctx: RollupContext): Promise<Rollups> {
  if (await needsRefresh(ctx)) await rebuild(ctx)

  const rows = (await ctx.sql`
    select
      to_char(local_date, 'YYYY-MM-DD') as date,
      distance_m, elapsed_s, fixes,
      start_lon, start_lat, end_lon, end_lat,
      gain_m, net_m, high_m, low_m, reconstructed
    from day_rollups
    where mode = ${ctx.mode}
    order by local_date
  `) as unknown as RollupRow[]

  const cached = (await ctx.sql`
    select points from trail_cache where mode = ${ctx.mode}
  `) as unknown as { points: [number, number][] }[]

  return {
    days: rows.map(toSummary),
    distanceM: rows.reduce((sum, r) => sum + r.distance_m, 0),
    fixes: rows.reduce((sum, r) => sum + r.fixes, 0),
    trail: cached[0]?.points ?? [],
  }
}
