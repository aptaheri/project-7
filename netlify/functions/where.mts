import { db, ensureSchema } from '../lib/db.mts'
import { testDevices } from '../lib/devices.mts'
import { countryAt } from '../lib/country.mts'
import type { Country } from '../lib/country.mts'

/**
 * Public endpoint: which country the rider is in, and nothing finer.
 *
 * The live tracker is behind Google sign-in because a map of exactly where he is
 * sleeping is not something to hand the open internet. A country is a different
 * kind of fact — it is on his own social posts and in the published itinerary
 * already — so this deliberately sits outside the auth wall.
 *
 * What keeps that safe is the shape of the response rather than a promise about
 * it: this handler answers with a name, a two-letter code and a flag. No
 * coordinates, no town, no timestamp, no distance. There is nothing here to
 * narrow down, because the narrowing happened before the JSON was built.
 */

/** Country is not a fast-moving figure; one lookup serves everyone for a while. */
const CACHE_MS = 15 * 60 * 1000

/**
 * How old the last fix may be and still be described as "currently".
 *
 * A phone off for an afternoon changes nothing about which country he is in, so
 * this is generous. But the trip flies between continents, and a tracker that
 * stays off for the flight and the first days after it would leave the homepage
 * confidently announcing Spain while he is in Australia. Past this, the line
 * disappears instead — the same call the leg matcher makes when nothing fits.
 */
const STALE_DAYS = 5

interface WhereBody {
  country: string | null
  code: string | null
  flag: string | null
}

const UNKNOWN: WhereBody = { country: null, code: null, flag: null }

function bodyFor(country: Country | null): WhereBody {
  if (!country) return UNKNOWN
  return { country: country.name, code: country.code, flag: country.flag }
}

/**
 * A cacheable answer.
 *
 * The homepage is the busiest page on the site and this is the only request it
 * makes, so the CDN holds the answer and refreshes it in the background: a
 * thousand visitors cost one query, not a thousand. Compute here is billed for
 * waking Postgres, not for serving bytes.
 */
function cached(body: WhereBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
      'netlify-cdn-cache-control': 'public, s-maxage=900, stale-while-revalidate=3600',
    },
  })
}

/**
 * An answer we are not confident in: held briefly, then retried.
 *
 * Deliberately still cacheable for a minute. A failure path that sets no-store
 * takes the CDN out of the picture exactly when the upstream is struggling, so an
 * outage would turn every homepage view into its own database query and geocode
 * attempt — traffic amplifying a problem instead of being absorbed by it.
 */
function provisional(body: WhereBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'netlify-cdn-cache-control': 'public, s-maxage=60',
    },
  })
}

let cache: { at: number; body: WhereBody } | null = null

/**
 * The last country we successfully resolved.
 *
 * Kept separately from the cache so a Mapbox outage degrades to yesterday's
 * answer — which for a country is almost certainly still true — rather than to a
 * line that vanishes off the homepage.
 */
let lastGood: WhereBody | null = null

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  if (cache && Date.now() - cache.at < CACHE_MS) return cached(cache.body)

  let latest: { lat: number; lon: number; age_days: number } | null = null
  try {
    await ensureSchema()
    // `= false` is the production half of the same test-vs-real split the live
    // feed uses: everything not on the test list counts as real riding.
    const rows = (await db()`
      -- Cast to float8 so the driver hands back a number: Postgres types this
      -- expression as numeric, which arrives as a string, and a string would
      -- compare against the staleness threshold only by lucky coercion.
      select lat, lon, (extract(epoch from (now() - tst)) / 86400.0)::float8 as age_days
      from locations
      where (device = any(${testDevices()}::text[])) = false
        and source = 'device'
      order by tst desc
      limit 1
    `) as unknown as { lat: number; lon: number; age_days: number }[]
    latest = rows[0] ?? null
  } catch (error) {
    console.error('where lookup failed', error)
    return provisional(lastGood ?? UNKNOWN)
  }

  // Nothing to report yet, or nothing recent enough to call current. Both are
  // real answers and both are cheap to cache.
  if (!latest || latest.age_days > STALE_DAYS) {
    const body = UNKNOWN
    cache = { at: Date.now(), body }
    return cached(body)
  }

  const country = await countryAt(latest.lat, latest.lon)
  if (!country) return provisional(lastGood ?? UNKNOWN)

  const body = bodyFor(country)
  cache = { at: Date.now(), body }
  lastGood = body
  return cached(body)
}
