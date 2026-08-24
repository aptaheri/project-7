import plan from '../../src/data/itinerary.json'
import { db, ensureSchema } from './db.mts'
import { simplify } from './rollups.mts'

/**
 * The route as it now stands, which is not the same thing as the route he set
 * out with.
 *
 * `src/data/itinerary.json` is the plan: 467 days written before he left, still
 * the thing "one day behind schedule" is measured against. It does not change
 * when he changes his mind, because a schedule that moves to match reality can
 * never report drift.
 *
 * This table is what actually happened and what he intends next. He edits it
 * himself from the road — the night he stopped twelve miles short of Mende, the
 * only record was a text message that sat in a phone in another timezone until
 * after the morning's email had already gone out saying otherwise.
 *
 * Everything downstream reads the merge: a day the database knows about wins,
 * and every other day is the plan.
 */

export type DayKind = 'ride' | 'rest' | 'travel' | 'other'

export interface RouteDay {
  day: number
  date: string
  stage: string
  kind: DayKind
  from: string | null
  to: string | null
  miles: number | null
  note: string
  fromCoords: [number, number] | null
  toCoords: [number, number] | null
  needsReview: boolean
  /** What Mapbox makes of riding it, for reference. His own number wins. */
  cyclingMiles?: number | null
  /** The cycling line, for the map and the email. */
  routeCoords?: [number, number][] | null
  /** True when this day has been changed from the plan. */
  edited?: boolean
  editedBy?: string | null
  editedAt?: string | null
}

/** The plan he set out with. Never written to at runtime. */
export const PLAN = plan.days as RouteDay[]

interface Row {
  date: string
  kind: DayKind
  from_place: string | null
  to_place: string | null
  miles: number | null
  note: string | null
  from_lon: number | null
  from_lat: number | null
  to_lon: number | null
  to_lat: number | null
  cycling_miles: number | null
  route_coords: [number, number][] | null
  needs_review: boolean
  updated_by: string | null
  updated_at: string
}

function merge(day: RouteDay, row: Row): RouteDay {
  return {
    ...day,
    kind: row.kind,
    from: row.from_place,
    to: row.to_place,
    miles: row.miles,
    note: row.note ?? '',
    fromCoords: row.from_lon !== null && row.from_lat !== null ? [row.from_lon, row.from_lat] : null,
    toCoords: row.to_lon !== null && row.to_lat !== null ? [row.to_lon, row.to_lat] : null,
    needsReview: row.needs_review,
    cyclingMiles: row.cycling_miles,
    routeCoords: row.route_coords,
    edited: true,
    editedBy: row.updated_by,
    editedAt: row.updated_at,
  }
}

/**
 * The plan with his changes laid over it.
 *
 * Reads every edit rather than a window of them: there are 467 days and he has
 * changed a handful, so this is a small table and one query, and the callers
 * all want to scan for a date anyway.
 */
export async function loadRoute(): Promise<RouteDay[]> {
  try {
    await ensureSchema()
    const rows = (await db()`
      select
        to_char(date, 'YYYY-MM-DD') as date, kind, from_place, to_place, miles, note,
        from_lon, from_lat, to_lon, to_lat, cycling_miles, route_coords, needs_review,
        updated_by, updated_at::text as updated_at
      from route_days
    `) as unknown as Row[]

    if (rows.length === 0) return PLAN

    const edits = new Map(rows.map((row) => [row.date, row]))
    return PLAN.map((day) => {
      const row = edits.get(day.date)
      return row ? merge(day, row) : day
    })
  } catch (error) {
    // The plan is a fine answer when the database is unreachable, and much
    // better than no route at all: it is what every one of these days said
    // until somebody changed it.
    console.error('route: falling back to the plan', error)
    return PLAN
  }
}

/** Points kept in the line drawn in the email, where the URL has a length limit. */
const EMAIL_LINE_POINTS = 60

/** How far the drawn line may stray from the ridden one, in metres. */
const LINE_TOLERANCE_M = 60

export interface CyclingRoute {
  miles: number
  coords: [number, number][]
}

/**
 * What it is to ride between two points, according to Mapbox.
 *
 * Used to fill in a distance so he does not have to estimate one at the end of a
 * day's climbing, and to draw the day's actual roads rather than a straight line
 * across the countryside. His own number still wins when he gives one: for
 * Chanac to Aubenas this returns 71 miles and he rode 78, because he does not
 * ride the route an API would choose.
 */
export async function cyclingRoute(
  from: [number, number],
  to: [number, number],
): Promise<CyclingRoute | null> {
  const token = process.env.VITE_MAPBOX_TOKEN ?? process.env.MAPBOX_TOKEN
  if (!token) {
    console.warn('route: no Mapbox token, skipping directions')
    return null
  }

  const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/cycling/${coords}` +
    `?geometries=geojson&overview=full&access_token=${token}`

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) {
      console.warn(`route: directions returned ${response.status}`)
      return null
    }
    const body = (await response.json()) as {
      code?: string
      routes?: { distance: number; geometry: { coordinates: [number, number][] } }[]
    }
    // No cycling route between two points is an ordinary answer — a ferry
    // crossing, a closed pass, the wrong side of an ocean — not an error.
    if (body.code !== 'Ok' || !body.routes?.[0]) return null

    const route = body.routes[0]
    return { miles: route.distance / 1609.344, coords: route.geometry.coordinates }
  } catch (error) {
    console.warn('route: directions failed', error)
    return null
  }
}

/** Points kept in the line sent to the live map, which every poll carries. */
const MAP_LINE_POINTS = 120

/**
 * A day's line, thinned to a budget.
 *
 * Shape-aware rather than every-nth-point, for the same reason the trail is:
 * dropping points evenly straightens exactly the hairpins that make a mountain
 * day look like a mountain day. A full day of French back roads comes back from
 * Mapbox as a thousand points and seventeen kilobytes, which is more than the
 * entire live payload.
 */
export function thinLine(coords: [number, number][], budget: number): [number, number][] {
  if (coords.length <= budget) return coords
  let tolerance = LINE_TOLERANCE_M
  let line = simplify(coords, tolerance)
  while (line.length > budget && tolerance < 20_000) {
    tolerance *= 1.8
    line = simplify(coords, tolerance)
  }
  return line
}

/** The line as the email draws it, where the whole thing must fit in a URL. */
export function lineForEmail(coords: [number, number][]): [number, number][] {
  return thinLine(coords, EMAIL_LINE_POINTS)
}

/** The line as the live map draws it, carried by every poll. */
export function lineForMap(coords: [number, number][]): [number, number][] {
  return thinLine(coords, MAP_LINE_POINTS)
}

export interface SaveDay {
  date: string
  kind: DayKind
  from: string | null
  fromCoords: [number, number] | null
  to: string | null
  toCoords: [number, number] | null
  /** Null asks for the cycling distance to be used. */
  miles: number | null
  note: string
  needsReview: boolean
}

/**
 * Records a change to one day, and works out the road between its ends.
 *
 * The directions call happens here rather than in the browser so that the
 * distance and the line are written down once, by the thing that owns them,
 * instead of being recomputed by every reader afterwards.
 */
export async function saveDay(input: SaveDay, editor: string): Promise<RouteDay> {
  await ensureSchema()
  const sql = db()

  let cycling: CyclingRoute | null = null
  if (input.kind !== 'rest' && input.fromCoords && input.toCoords) {
    cycling = await cyclingRoute(input.fromCoords, input.toCoords)
  }

  // His number if he gave one, the road's if he did not, and nothing rather
  // than a guess if neither exists.
  const miles = input.miles ?? (cycling ? Math.round(cycling.miles) : null)

  await sql`
    insert into route_days (
      date, kind, from_place, to_place, miles, note,
      from_lon, from_lat, to_lon, to_lat,
      cycling_miles, route_coords, needs_review, updated_by, updated_at
    ) values (
      ${input.date}::date, ${input.kind}, ${input.from}, ${input.to}, ${miles}, ${input.note},
      ${input.fromCoords?.[0] ?? null}, ${input.fromCoords?.[1] ?? null},
      ${input.toCoords?.[0] ?? null}, ${input.toCoords?.[1] ?? null},
      ${cycling?.miles ?? null}, ${JSON.stringify(cycling?.coords ?? null)}::jsonb,
      ${input.needsReview}, ${editor}, now()
    )
    on conflict (date) do update set
      kind = excluded.kind,
      from_place = excluded.from_place, to_place = excluded.to_place,
      miles = excluded.miles, note = excluded.note,
      from_lon = excluded.from_lon, from_lat = excluded.from_lat,
      to_lon = excluded.to_lon, to_lat = excluded.to_lat,
      cycling_miles = excluded.cycling_miles, route_coords = excluded.route_coords,
      needs_review = excluded.needs_review,
      updated_by = excluded.updated_by, updated_at = now()
  `

  const days = await loadRoute()
  return days.find((d) => d.date === input.date) as RouteDay
}

/**
 * Moves the following day's start to wherever this one now ends.
 *
 * Called after a destination changes, because the alternative is an itinerary
 * that says he rides from a town he never reached. Only the origin moves — where
 * he goes next is his to decide, so its distance is dropped rather than
 * recomputed against a destination he may be about to change too.
 */
export async function rechainNextDay(date: string, editor: string): Promise<RouteDay | null> {
  const days = await loadRoute()
  const index = days.findIndex((d) => d.date === date)
  if (index < 0 || index + 1 >= days.length) return null

  const today = days[index]
  const next = days[index + 1]
  if (next.kind === 'rest' || !today.to || next.from === today.to) return null

  return saveDay(
    {
      date: next.date,
      kind: next.kind,
      from: today.to,
      fromCoords: today.toCoords,
      to: next.to,
      toCoords: next.toCoords,
      miles: null,
      note: next.note,
      needsReview: true,
    },
    editor,
  )
}
