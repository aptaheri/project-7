/**
 * Runs the public country endpoint against a real Postgres, and checks what it
 * refuses to say.
 *
 * The SQL is small; the reason this file exists is the other half. /api/where is
 * the only unauthenticated view of live location on the site, so the test that
 * matters is that the payload carries a country and nothing that could be used
 * to place him inside it. That is an assertion about the response body, and it
 * would go unnoticed forever if a later change added a field.
 *
 * Mapbox is stubbed rather than called: the check must pass in CI with no token
 * and must not depend on someone else's uptime.
 *
 *   npm run check-where
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()

const OIDS = { textArray: 1009, text: 25, int: 20, float: 701, bool: 16 }

function oidFor(value) {
  if (typeof value === 'boolean') return OIDS.bool
  if (typeof value === 'number') return Number.isInteger(value) ? OIDS.int : OIDS.float
  if (Array.isArray(value)) return OIDS.textArray
  return OIDS.text
}

function tagged(strings, ...values) {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
    '',
  )
  return pg
    .query(text, values, { paramTypes: values.map(oidFor) })
    .then((r) => r.rows)
}

const dir = 'node_modules/.p7-sql-check'
mkdirSync(dir, { recursive: true })
const shimPath = resolve(dir, 'db-shim-where.mjs')
writeFileSync(shimPath, `
export function db() { return globalThis.__pg }
export async function ensureSchema() {}
`)

process.env.TRACK_TEST_DEVICES = 'testphone'
process.env.VITE_MAPBOX_TOKEN = 'pk.test'

const bundle = await esbuild.build({
  entryPoints: ['netlify/functions/where.mts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [
    {
      name: 'swap-db',
      setup(build) {
        build.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath }))
      },
    },
  ],
})
const outPath = join(dir, 'where.mjs')
writeFileSync(outPath, bundle.outputFiles[0].text)

await pg.exec(`
  create table locations (
    id bigserial primary key,
    device text not null, tst timestamptz not null,
    lat double precision not null, lon double precision not null,
    acc double precision, alt double precision, vel double precision,
    cog double precision, batt smallint, bs smallint,
    conn text, tid text, source text not null default 'device',
    raw jsonb not null default '{}'::jsonb,
    received_at timestamptz not null default now(),
    constraint locations_device_tst_key unique (device, tst)
  );
`)

// Canfranc, on the Spanish side of the Pyrenees.
const LAT = 42.7178
const LON = -0.5236

async function fix({ device = 'phone', minutesAgo, lat = LAT, lon = LON }) {
  await pg.query(
    `insert into locations (device, tst, lat, lon, source, raw)
     values ($1, now() - make_interval(mins => $2), $3, $4, 'device', '{}'::jsonb)`,
    [device, Math.round(minutesAgo), lat, lon],
  )
}

/** How many times the stub was asked, so caching can be checked. */
let geocodeCalls = 0
let geocodeStatus = 200

globalThis.fetch = async (url) => {
  if (!String(url).includes('api.mapbox.com')) throw new Error(`unexpected fetch: ${url}`)
  geocodeCalls++
  if (geocodeStatus !== 200) return new Response('nope', { status: geocodeStatus })
  return new Response(
    JSON.stringify({
      features: [
        {
          properties: {
            name: 'Spain',
            context: { country: { name: 'Spain', country_code: 'es' } },
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

globalThis.__pg = tagged

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * A fresh copy of the module, so its in-memory cache starts empty.
 *
 * The caches are module state by design — that is what keeps the endpoint cheap
 * — so each scenario needs its own instance or it would just be served the
 * previous scenario's answer.
 */
let instance = 0
async function freshHandler() {
  const { default: handler } = await import(`${pathToFileURL(outPath).href}?i=${++instance}`)
  return handler
}

const request = () => new Request('https://project7.bike/api/where')

// ── A live fix ────────────────────────────────────────────────────────────────
await fix({ minutesAgo: 20 })

let handler = await freshHandler()
let res = await handler(request())
check('handler returns 200', res.status === 200, `HTTP ${res.status}`)

let text = await res.text()
let body = JSON.parse(text)
check('country resolved', body.country === 'Spain', body.country)
check('code is uppercased', body.code === 'ES', body.code)
check('flag derived from the code', body.flag === '🇪🇸', body.flag)

// The whole point of the endpoint: a country, and no way to place him in it.
check(
  'no fields beyond country, code and flag',
  JSON.stringify(Object.keys(body).sort()) === '["code","country","flag"]',
  Object.keys(body).join(', '),
)
check('no coordinates in the payload', !/42\.7|-0\.52/.test(text), text)
check('no timestamp in the payload', !/\d{4}-\d{2}-\d{2}|age|tst/i.test(text), text)

check('answer is cacheable', /max-age=300/.test(res.headers.get('cache-control') ?? ''),
  res.headers.get('cache-control'))
check('CDN told to hold it longer',
  /s-maxage=900/.test(res.headers.get('netlify-cdn-cache-control') ?? ''),
  res.headers.get('netlify-cdn-cache-control'))

const callsAfterFirst = geocodeCalls
await handler(request())
check('a second request is served from cache', geocodeCalls === callsAfterFirst,
  `${geocodeCalls} geocode call(s)`)

// ── A test device is not the rider ───────────────────────────────────────────
await pg.query('delete from locations')
await fix({ device: 'testphone', minutesAgo: 5 })
handler = await freshHandler()
body = await (await handler(request())).json()
check('test fixes are not published', body.country === null, JSON.stringify(body))

// ── A fix too old to call "currently" ────────────────────────────────────────
await pg.query('delete from locations')
await fix({ minutesAgo: 9 * 24 * 60 })
handler = await freshHandler()
res = await handler(request())
body = await res.json()
check('a nine-day-old fix is not current', body.country === null, JSON.stringify(body))
check('the stale answer is still cacheable',
  /max-age=300/.test(res.headers.get('cache-control') ?? ''),
  res.headers.get('cache-control'))

// ── No riding at all ─────────────────────────────────────────────────────────
await pg.query('delete from locations')
handler = await freshHandler()
body = await (await handler(request())).json()
check('no fixes is a clean null', body.country === null, JSON.stringify(body))

// ── Mapbox down ──────────────────────────────────────────────────────────────
await fix({ minutesAgo: 15 })
geocodeStatus = 503
handler = await freshHandler()
res = await handler(request())
body = await res.json()
check('a geocoder outage answers null rather than failing', res.status === 200 && body.country === null,
  `HTTP ${res.status} ${JSON.stringify(body)}`)
// Held for a minute rather than not at all: an outage must not turn every
// homepage view into its own failing geocode attempt.
check('an outage is held only briefly', /max-age=60\b/.test(res.headers.get('cache-control') ?? ''),
  res.headers.get('cache-control'))

// And once it recovers, the same instance resolves — nothing was poisoned.
geocodeStatus = 200
body = await (await handler(request())).json()
check('recovery needs no redeploy', body.country === 'Spain', JSON.stringify(body))

// ── Antarctica, where there is no country to geocode ─────────────────────────
await pg.query('delete from locations')
await fix({ minutesAgo: 10, lat: -77.85, lon: 166.67 })
geocodeStatus = 200
const noFeature = globalThis.fetch
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.mapbox.com')) throw new Error(`unexpected fetch: ${url}`)
  geocodeCalls++
  return new Response(JSON.stringify({ features: [] }), { status: 200 })
}
handler = await freshHandler()
body = await (await handler(request())).json()
check('below 60°S reads as Antarctica', body.country === 'Antarctica' && body.flag === '🇦🇶',
  JSON.stringify(body))
globalThis.fetch = noFeature

// ── Method ───────────────────────────────────────────────────────────────────
res = await handler(new Request('https://project7.bike/api/where', { method: 'POST' }))
check('POST is refused', res.status === 405, `HTTP ${res.status}`)

console.log(failures === 0 ? '\nAll where checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
