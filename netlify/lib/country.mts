/**
 * Which country a coordinate falls in, as a name, an ISO code and a flag.
 *
 * Reverse geocoded from the last fix rather than read off the itinerary: the
 * schedule says where he is meant to be and the tracker says where he is, and
 * only one of those belongs under a label that reads "currently". He has already
 * been days behind it once.
 *
 * Mapbox is asked for the country and nothing below it, so the only thing that
 * ever comes back is the answer we are willing to publish.
 */

export interface Country {
  name: string
  /** ISO 3166-1 alpha-2, uppercase. */
  code: string
  flag: string
}

/** A country name for a code, for when the geocoder gives a code but no name. */
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' })

/**
 * The flag emoji for a country code.
 *
 * A flag is the two letters written in regional indicator symbols, which sit a
 * fixed distance above A-Z — so this is arithmetic, not a lookup table that
 * would need maintaining for all 195 countries the route touches.
 */
function flagFor(code: string): string {
  return String.fromCodePoint(
    ...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  )
}

/**
 * South of this there is no country to geocode.
 *
 * The Antarctic Treaty suspends every territorial claim below 60°S, so Mapbox
 * correctly returns no country there — and stage 7 would silently lose the line
 * on the most interesting leg of the trip. AQ is a real ISO code with a real
 * flag, so the honest answer is available without inventing anything.
 */
const ANTARCTIC_LATITUDE = -60

/** One lookup takes ~200 ms; every viewer polling for it would be absurd. */
const CACHE_MS = 60 * 60 * 1000

let cache: { at: number; key: string; value: Country | null } | null = null

function mapboxToken(): string | null {
  return process.env.VITE_MAPBOX_TOKEN ?? process.env.MAPBOX_TOKEN ?? null
}

interface ReverseResponse {
  features?: {
    properties?: {
      name?: string
      context?: { country?: { name?: string; country_code?: string } }
    }
  }[]
}

/**
 * Returns the country, or null when there is honestly no answer — mid-ocean, or
 * with the geocoder unreachable. Null is not an error to swallow further up: the
 * homepage drops the line rather than guessing at a country.
 */
export async function countryAt(lat: number, lon: number): Promise<Country | null> {
  // Rounded to about a kilometre: he moves within a country all day, and a fresh
  // lookup for every metre of that would be paying to be told the same thing.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.value
  }

  const token = mapboxToken()
  if (!token) {
    console.error('country lookup skipped: no Mapbox token configured')
    return null
  }

  try {
    const url =
      'https://api.mapbox.com/search/geocode/v6/reverse' +
      `?longitude=${lon}&latitude=${lat}&types=country&access_token=${token}`
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = (await res.json()) as ReverseResponse
    const properties = body.features?.[0]?.properties
    const code = properties?.context?.country?.country_code?.toUpperCase()

    let value: Country | null = null
    if (code && /^[A-Z]{2}$/.test(code)) {
      const name = properties?.context?.country?.name ?? properties?.name
      value = {
        name: name ?? REGION_NAMES.of(code) ?? code,
        code,
        flag: flagFor(code),
      }
    } else if (lat <= ANTARCTIC_LATITUDE) {
      value = { name: 'Antarctica', code: 'AQ', flag: flagFor('AQ') }
    }

    cache = { at: Date.now(), key, value }
    return value
  } catch (error) {
    console.error('country lookup failed', error)
    // Deliberately not cached: a blip should cost one viewer the line, not
    // everybody for the next hour. The caller keeps the last good answer.
    return null
  }
}
