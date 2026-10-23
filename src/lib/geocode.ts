/**
 * Looking up a town by name, for the route editor.
 *
 * Extracted from the page it serves so the type list can be checked. The first
 * version of this asked Mapbox for types "village" and "town", which are not
 * Mapbox types — every search returned 422, the suggestion list was always
 * empty, and John could not change a destination at all. Nothing said so: the
 * failure was a silent empty array behind a box that looked like it was working.
 */

/**
 * Mapbox's complete set of geocoding types, from the 422 it returns when given
 * one it does not know. Here so a typo is caught by a test rather than by a
 * rider in a French village at the end of a hundred miles.
 */
export const MAPBOX_TYPES = [
  'country',
  'region',
  'place',
  'district',
  'locality',
  'postcode',
  'neighborhood',
] as const

/**
 * What counts as a destination on this trip.
 *
 * "place" is Mapbox's word for a settlement of any size, from a city to a
 * hamlet, which is the whole range he stops in. "locality" catches the small
 * named places that sit inside a commune, which in rural France is often
 * exactly where a night ends.
 */
export const DESTINATION_TYPES = ['place', 'locality', 'district'] as const

export interface Place {
  name: string
  context: string
  coords: [number, number]
  /** Straight-line km from where the day starts, when that is known. */
  km?: number
}

export class GeocodeError extends Error {}

/**
 * How far a day's destination can plausibly be from where it starts.
 *
 * The editor caps a day at 400 miles. "Say-Otes" came back as Oteștii de Sus
 * in Romania, 2,400 km behind him, and was saved without a word because it
 * was the first answer — two days drawn as lines back across the Black Sea.
 */
export const MAX_DAY_KM = 650

/** OpenStreetMap's word for a settlement, as Photon reports it. */
const OSM_SETTLEMENTS = new Set([
  'city', 'town', 'village', 'hamlet', 'locality', 'isolated_dwelling', 'suburb', 'neighbourhood',
])

function kmBetween(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b[1] - a[1])
  const dLon = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

async function mapbox(
  query: string,
  near: [number, number] | null,
  token: string,
): Promise<Place[]> {
  const proximity = near ? `&proximity=${near[0]},${near[1]}` : ''
  // In English. Left to itself Mapbox names a town in its own script, and the
  // name he saves is the one in the email's subject line and the tracker's
  // panel — through Georgia that was "ვალე → აწყური", to forty readers who all
  // read English.
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
    `?types=${DESTINATION_TYPES.join(',')}&limit=5&language=en${proximity}&access_token=${token}`

  const response = await fetch(url)
  if (!response.ok) {
    throw new GeocodeError(`Place search failed (${response.status}).`)
  }

  const body = (await response.json()) as {
    features?: { text: string; place_name: string; center: [number, number] }[]
  }
  return (body.features ?? []).map((f) => ({
    name: f.text,
    context: f.place_name,
    coords: f.center,
  }))
}

/**
 * The same question asked of OpenStreetMap, through Photon.
 *
 * Mapbox is thin across Central Asia: it has no Karakalpakiya at all, the
 * border village on the road from Beyneu into Uzbekistan that Google Maps and
 * OpenStreetMap both know. Free, keyless and open to browsers, and asked once
 * per search rather than per keystroke.
 */
async function photon(query: string, near: [number, number] | null): Promise<Place[]> {
  const bias = near ? `&lon=${near[0]}&lat=${near[1]}` : ''
  const response = await fetch(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=en${bias}`,
  )
  if (!response.ok) throw new GeocodeError(`Place search failed (${response.status}).`)
  const body = (await response.json()) as {
    features?: {
      geometry?: { coordinates?: [number, number] }
      properties?: { name?: string; osm_value?: string; state?: string; country?: string }
    }[]
  }
  return (body.features ?? [])
    .filter((f) => f.properties?.name && f.geometry?.coordinates)
    .filter((f) => OSM_SETTLEMENTS.has(f.properties?.osm_value ?? ''))
    .map((f) => {
      const p = f.properties ?? {}
      return {
        name: p.name as string,
        context: [p.name, p.state, p.country].filter(Boolean).join(', '),
        coords: f.geometry?.coordinates as [number, number],
      }
    })
}

/**
 * Towns matching what he has typed, nearest to where the day starts.
 *
 * Asks Mapbox and OpenStreetMap together, and Mapbox again without the hyphen
 * when there is one — "Say-Otes" finds nothing in Kazakhstan, "SayOtes" finds
 * Saiotes. Sorted by distance from where the day starts, because the right
 * answer is almost always the one he can ride to.
 *
 * Throws rather than returning nothing when the lookup itself fails, so the
 * page can say "search is not working" instead of "no such town" — the two
 * look identical to somebody typing, and only one of them is his fault. One
 * source failing is not that: the other may still have the town.
 */
export async function searchPlaces(
  query: string,
  near: [number, number] | null,
  token: string | undefined,
): Promise<Place[]> {
  if (!token) throw new GeocodeError('No Mapbox token configured.')
  const q = query.trim()
  if (q.length < 2) return []

  const joined = q.replace(/[-\s'’]+/g, '')
  const asks = [mapbox(q, near, token), photon(q, near)]
  if (joined !== q && joined.length >= 2) asks.push(mapbox(joined, near, token))
  const answers = await Promise.allSettled(asks)

  const found = answers.flatMap((a) => (a.status === 'fulfilled' ? a.value : []))
  if (found.length === 0) {
    const failed = answers.find((a) => a.status === 'rejected')
    if (failed) throw failed.reason
  }

  // The same town from two sources is one suggestion. Mapbox's comes first and
  // wins, since its names are the ones the rest of the site has been using.
  const unique: Place[] = []
  for (const place of found) {
    if (!unique.some((u) => kmBetween(u.coords, place.coords) < 3)) unique.push(place)
  }

  if (!near) return unique.slice(0, 6)
  return unique
    .map((place) => ({ ...place, km: Math.round(kmBetween(near, place.coords)) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 6)
}
