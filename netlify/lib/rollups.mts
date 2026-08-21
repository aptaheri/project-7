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

/**
 * What the live feed needs from the history: two numbers and a token.
 *
 * Deliberately not the line or the day list. Those are the large half, they
 * change once a day, and re-sending them on every poll is what the split
 * exists to stop.
 */
export interface RollupTotals {
  /** Metres ridden across every finished day, measured and reconstructed. */
  distanceM: number
  /** Fixes recorded across every finished day. */
  fixes: number
  /** Changes only when the stored history does, so a client can skip refetching. */
  version: string
}

/** The large half, fetched once a session. */
export interface RollupHistory {
  days: DaySummary[]
  trail: [number, number][]
  version: string
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

/**
 * Most points the stored history line may carry.
 *
 * Fetched once a session rather than on every poll, so it can afford detail
 * that would be absurd to re-send every thirty seconds. Forty thousand points
 * is roughly a megabyte of JSON — a couple of map tiles — for the whole
 * expedition.
 */
const HISTORY_POINT_BUDGET = 40_000

/**
 * Rows the first pass may return, before the shape-aware pass runs.
 *
 * Only a memory bound: a function reading half a million rows to draw a line is
 * a different kind of problem from one sending them.
 */
const RAW_POINT_CEILING = 250_000

/**
 * How far the drawn line may stray from the recorded one, in metres.
 *
 * Not a spacing. Thinning by distance — one point every N metres — is what
 * makes a route stop following roads: it drops the apex of every switchback and
 * cuts every corner, because it has no idea which points carry the shape. This
 * is the tolerance of a Douglas-Peucker simplification instead, which keeps a
 * point precisely when leaving it out would move the line by more than this,
 * so a straight run across the Nullarbor costs two points and a climb into the
 * Pyrenees keeps every hairpin.
 *
 * 12 m is under a pixel until about zoom 14 — street level — so the line
 * follows the road at any zoom anyone is likely to use.
 */
const HISTORY_TOLERANCE_M = 12

/** Raised, if it must be, until the line fits the budget. */
const TOLERANCE_GROWTH = 1.7

const MIN_SPACING_M = 25

const EARTH_RADIUS_M = 6_371_000

/**
 * Perpendicular distance from a point to the line through two others, in metres.
 *
 * Longitude is scaled by the cosine of the latitude so a degree east is worth
 * what it is actually worth at that latitude — without it the simplification
 * would be increasingly wrong the further from the equator he rides, and this
 * route reaches both poles.
 */
function perpendicularM(
  point: [number, number],
  start: [number, number],
  end: [number, number],
): number {
  const scale = Math.cos((point[1] * Math.PI) / 180)
  const toM = (deg: number) => (deg * Math.PI * EARTH_RADIUS_M) / 180
  const px = toM((point[0] - start[0]) * scale)
  const py = toM(point[1] - start[1])
  const ex = toM((end[0] - start[0]) * scale)
  const ey = toM(end[1] - start[1])

  const lengthSq = ex * ex + ey * ey
  if (lengthSq === 0) return Math.hypot(px, py)

  // Where the foot of the perpendicular falls along the segment, clamped to it.
  const t = Math.max(0, Math.min(1, (px * ex + py * ey) / lengthSq))
  return Math.hypot(px - t * ex, py - t * ey)
}

/**
 * Douglas-Peucker, iteratively rather than recursively.
 *
 * The recursive form is the one everybody writes, and on a track of several
 * hundred thousand fixes it recurses deep enough to blow the stack — of which
 * the first sign would be the map going blank halfway through the trip.
 */
export function simplify(points: [number, number][], toleranceM: number): [number, number][] {
  if (points.length < 3) return points.slice()

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1

  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number]
    let worst = 0
    let index = -1

    for (let i = first + 1; i < last; i++) {
      const distance = perpendicularM(points[i], points[first], points[last])
      if (distance > worst) {
        worst = distance
        index = i
      }
    }

    if (index !== -1 && worst > toleranceM) {
      keep[index] = 1
      stack.push([first, index], [index, last])
    }
  }

  return points.filter((_, i) => keep[i] === 1)
}

/**
 * Simplified as finely as the budget allows.
 *
 * Starts at the tolerance that looks right and loosens only if the result is
 * too big to send, so the line is as faithful as it can be for its size rather
 * than uniformly coarse for the whole trip.
 */
function simplifyToBudget(points: [number, number][], budget: number): {
  points: [number, number][]
  toleranceM: number
} {
  let toleranceM = HISTORY_TOLERANCE_M
  let simplified = simplify(points, toleranceM)
  while (simplified.length > budget && toleranceM < 5000) {
    toleranceM *= TOLERANCE_GROWTH
    simplified = simplify(points, toleranceM)
  }
  return { points: simplified, toleranceM }
}

/**
 * The drawn line for everything before today, simplified once and stored.
 */
async function rebuildTrail(ctx: RollupContext): Promise<void> {
  const { sql, mode, devices, isTest, todayStart, today } = ctx
  const before = todayStart.toISOString()

  const totals = (await sql`
    select coalesce(sum(distance_m), 0)::float8 as distance_m
    from day_rollups where mode = ${mode}
  `) as unknown as { distance_m: number }[]

  // A first pass in SQL, only to bound how much comes back into memory. It is
  // deliberately far finer than the line needs — the shape-aware pass below is
  // what decides which points survive, and it can only keep what it is given.
  const spacing = Math.max(MIN_SPACING_M, (totals[0]?.distance_m ?? 0) / RAW_POINT_CEILING)

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

  const { points, toleranceM } = simplifyToBudget(
    rows.map((r) => [r.lon, r.lat] as [number, number]),
    HISTORY_POINT_BUDGET,
  )
  console.log(
    `history trail rebuilt: ${rows.length} fixes -> ${points.length} points at ${toleranceM.toFixed(0)}m`,
  )
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

/** Brings the stored summaries up to date if anything has changed. */
async function refreshIfStale(ctx: RollupContext): Promise<void> {
  if (await needsRefresh(ctx)) await rebuild(ctx)
}

/**
 * The totals behind the live feed: an aggregate over a table with one row per
 * day, and the version token. Nothing here grows with how much he has ridden.
 */
export async function loadTotals(ctx: RollupContext): Promise<RollupTotals> {
  await refreshIfStale(ctx)

  const rows = (await ctx.sql`
    select
      coalesce(sum(distance_m), 0)::float8 as distance_m,
      coalesce(sum(fixes), 0)::int as fixes
    from day_rollups where mode = ${ctx.mode}
  `) as unknown as { distance_m: number; fixes: number }[]

  return {
    distanceM: rows[0]?.distance_m ?? 0,
    fixes: rows[0]?.fixes ?? 0,
    version: await version(ctx),
  }
}

/** The token the client compares against to decide whether to refetch. */
async function version(ctx: RollupContext): Promise<string> {
  const rows = (await ctx.sql`
    select computed_at::text as computed_at from trail_cache where mode = ${ctx.mode}
  `) as unknown as { computed_at: string }[]
  return rows[0]?.computed_at ?? 'empty'
}

/**
 * Every finished day and the line through them. The large half, fetched once a
 * session and again only when the version changes — which is once a day.
 */
export async function loadHistory(ctx: RollupContext): Promise<RollupHistory> {
  await refreshIfStale(ctx)

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
    trail: cached[0]?.points ?? [],
    version: await version(ctx),
  }
}
