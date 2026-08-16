import itinerary from '../../src/data/itinerary.json'

/**
 * Works out which leg of the plan the rider is actually on.
 *
 * The schedule is a plan, not a record. An injury, a headwind or a border queue
 * puts him days behind it, so the date alone is not enough — asserting today's
 * scheduled destination while he is somewhere else entirely would be worse than
 * saying nothing. Position decides; the date only narrows the field.
 */

interface Leg {
  date: string
  kind: string
  from: string | null
  to: string | null
  miles: number | null
  fromCoords: [number, number] | null
  toCoords: [number, number] | null
}

export interface CurrentLeg {
  date: string
  kind: 'ride' | 'rest'
  from: string | null
  to: string
  plannedMiles: number | null
  destination: [number, number]
  /** Straight line from him to the destination. */
  distanceToDestinationKm: number
  /**
   * Road distance still to ride, estimated.
   *
   * The straight line is not comparable to the planned mileage, which follows
   * roads — for this stretch of Spain the road is a third longer than the crow
   * flies, so showing the two side by side made a rider who had not left yet
   * look twenty miles in. Scaling by that leg's own ratio puts both numbers in
   * the same units. Null when there is no planned distance to take a ratio
   * from, and never more than the leg itself.
   */
  roadRemainingKm: number | null
  /** Negative when he is behind the plan, positive when ahead. */
  daysFromSchedule: number
}

/** How far either side of today to look for the leg he is on. */
const WINDOW_DAYS = 10

/** A rider is "at" a rest stop within this radius of it. */
const REST_RADIUS_KM = 25

/**
 * Close enough to a past leg's destination to call that leg finished.
 *
 * Sleeping in the town he rode to yesterday is not the same as being a day
 * behind, but geometrically the two are identical: he is standing on the finish
 * line of one leg and the start line of the next. Without this, the morning
 * after every ride reads as "1d behind" until he gets back on the bike.
 */
const ARRIVED_RADIUS_KM = 15

/** Smallest allowance for wandering off the straight line between two towns. */
const MIN_CORRIDOR_KM = 20

/** Roads are not straight; allow this share of the leg's length as slack. */
const CORRIDOR_FRACTION = 0.18

/**
 * Cost per day between the leg's date and today.
 *
 * Falling behind is routine — an injury already cost him days — so a past leg
 * is only mildly discouraged. Running ahead of the plan essentially does not
 * happen, and the geometry cannot tell "arriving at today's destination" from
 * "setting off on tomorrow's": both put him beside the same town. Left even,
 * the tie broke toward tomorrow's leg, because tolerance scales with leg length
 * and the next leg is usually longer. This makes a future leg win only when no
 * current or earlier leg fits at all, since any leg that fits scores under 1.
 */
const DAY_PENALTY_BEHIND = 0.12
const DAY_PENALTY_AHEAD = 1.2

/** Days between the leg's date and today, as a score penalty. */
function datePenalty(offset: number): number {
  return offset >= 0 ? offset * DAY_PENALTY_AHEAD : -offset * DAY_PENALTY_BEHIND
}

const KM_PER_MILE = 1.609344

/**
 * Road kilometres left, from the straight line and this leg's own windiness.
 *
 * Every road is longer than the line it follows, and by how much varies —
 * a valley climb into the Pyrenees is half as long again, a plain barely
 * differs. The leg's planned mileage against its straight length gives that
 * factor for free, and it is a far better estimate than either number alone.
 */
function roadRemaining(
  plannedMiles: number | null,
  legStraightKm: number,
  straightToGoKm: number,
): number | null {
  if (plannedMiles === null || legStraightKm <= 0) return null
  const plannedKm = plannedMiles * KM_PER_MILE
  return Math.min(plannedKm, straightToGoKm * (plannedKm / legStraightKm))
}

const EARTH_RADIUS_KM = 6371

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

function dayDifference(legDate: string, today: string): number {
  const a = Date.parse(`${legDate}T12:00:00Z`)
  const b = Date.parse(`${today}T12:00:00Z`)
  return Math.round((a - b) / 86_400_000)
}

/**
 * Returns the leg the rider appears to be on, or null when nothing fits.
 *
 * Null is a real answer, not a failure: on a day he has gone off-plan there is
 * no honest destination to show, and inventing one would be worse than a gap.
 */
function bestMatch(
  position: [number, number],
  today: string,
  /** Ignore legs he has already ridden to the end of. */
  skipFinished: boolean,
): CurrentLeg | null {
  const legs = itinerary.days as Leg[]

  let best: CurrentLeg | null = null
  let bestScore = Infinity

  for (const leg of legs) {
    if (!leg.toCoords || !leg.to) continue

    const offset = dayDifference(leg.date, today)
    if (Math.abs(offset) > WINDOW_DAYS) continue

    const destination = leg.toCoords
    const toDestination = haversineKm(position, destination)

    // A leg dated before today whose destination he is standing in is done.
    if (skipFinished && offset < 0 && toDestination <= ARRIVED_RADIUS_KM) continue

    if (leg.kind === 'rest') {
      // A rest day matches only by being at the place.
      if (toDestination > REST_RADIUS_KM) continue
      // Consecutive rest days sit in the same town, so the date breaks the tie.
      const score = toDestination / REST_RADIUS_KM + datePenalty(offset)
      if (score < bestScore) {
        bestScore = score
        best = {
          date: leg.date,
          kind: 'rest',
          from: null,
          to: leg.to,
          plannedMiles: null,
          destination,
          distanceToDestinationKm: toDestination,
          roadRemainingKm: null,
          daysFromSchedule: offset,
        }
      }
      continue
    }

    if (leg.kind !== 'ride' || !leg.fromCoords) continue

    // How far off the straight line between the two towns he is. Near zero
    // means he is somewhere along that leg; large means this is not his road.
    const legKm = haversineKm(leg.fromCoords, destination)
    const detour = haversineKm(position, leg.fromCoords) + toDestination - legKm
    const corridor = Math.max(MIN_CORRIDOR_KM, legKm * CORRIDOR_FRACTION)
    if (detour > corridor) continue

    // Prefer the tightest fit, then the leg whose date is closest to today.
    const score = detour / corridor + datePenalty(offset)
    if (score < bestScore) {
      bestScore = score
      best = {
        date: leg.date,
        kind: 'ride',
        from: leg.from,
        to: leg.to,
        plannedMiles: leg.miles,
        destination,
        distanceToDestinationKm: toDestination,
        roadRemainingKm: roadRemaining(leg.miles, legKm, toDestination),
        daysFromSchedule: offset,
      }
    }
  }

  return best
}

export function currentLeg(
  position: [number, number],
  today: string,
): CurrentLeg | null {
  const best = bestMatch(position, today, false)

  // If the winner is a leg he finished on an earlier day, he is not behind on
  // it — he is standing at the end of it, most likely asleep, with the next one
  // starting from the same spot. Ask again ignoring the legs already ridden,
  // and take that answer when there is one. When there is not, keep the
  // original: still being in yesterday's town having ridden nowhere since is
  // exactly what falling behind looks like.
  if (best && best.daysFromSchedule < 0 && best.distanceToDestinationKm <= ARRIVED_RADIUS_KM) {
    const ahead = bestMatch(position, today, true)
    if (ahead) return ahead
  }

  return best
}
