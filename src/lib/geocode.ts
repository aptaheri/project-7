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
}

export class GeocodeError extends Error {}

/**
 * Towns matching what he has typed, nearest to where the day starts.
 *
 * Throws rather than returning nothing when the lookup itself fails, so the
 * page can say "search is not working" instead of "no such town" — the two
 * look identical to somebody typing, and only one of them is his fault.
 */
export async function searchPlaces(
  query: string,
  near: [number, number] | null,
  token: string | undefined,
): Promise<Place[]> {
  if (!token) throw new GeocodeError('No Mapbox token configured.')
  if (query.trim().length < 2) return []

  const proximity = near ? `&proximity=${near[0]},${near[1]}` : ''
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json` +
    `?types=${DESTINATION_TYPES.join(',')}&limit=5${proximity}&access_token=${token}`

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
