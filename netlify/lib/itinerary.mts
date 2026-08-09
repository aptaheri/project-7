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
  distanceToDestinationKm: number
  /** Negative when he is behind the plan, positive when ahead. */
  daysFromSchedule: number
}

/** How far either side of today to look for the leg he is on. */
const WINDOW_DAYS = 10

/** A rider is "at" a rest stop within this radius of it. */
const REST_RADIUS_KM = 25

/** Smallest allowance for wandering off the straight line between two towns. */
const MIN_CORRIDOR_KM = 20

/** Roads are not straight; allow this share of the leg's length as slack. */
const CORRIDOR_FRACTION = 0.18

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
export function currentLeg(
  position: [number, number],
  today: string,
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

    if (leg.kind === 'rest') {
      // A rest day matches only by being at the place.
      if (toDestination > REST_RADIUS_KM) continue
      // Consecutive rest days sit in the same town, so the date breaks the tie.
      const score =
        toDestination / REST_RADIUS_KM + Math.abs(offset) / (WINDOW_DAYS * 100)
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

    // Prefer the tightest fit, and break ties towards the scheduled date.
    const score = detour / corridor + Math.abs(offset) / (WINDOW_DAYS * 100)
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
        daysFromSchedule: offset,
      }
    }
  }

  return best
}
