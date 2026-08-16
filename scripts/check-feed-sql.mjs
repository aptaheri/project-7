/**
 * Runs the whole live feed against a real Postgres.
 *
 * track-feed is the largest body of SQL in the project and was the one part
 * without cover, which is where both of the SQL bugs that reached production
 * came from. It calls the actual exported handler with a real signed session,
 * so every query in the request path executes — nothing is retyped here, which
 * is the point: the last local test to miss a bug had quietly substituted a
 * literal for the interpolation that was broken.
 *
 *   npm run check-feed
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()

// Postgres cannot infer a type for a parameter in some positions — a window
// frame offset is the one that bites here — and defaults it to text, which then
// fails to parse as an integer. Neon's driver states the types on the wire, so
// this says them explicitly to match rather than to paper over anything.
const TEXT = 25
const OIDS = { int: 20, float: 701, bool: 16, text: TEXT, textArray: 1009 }

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
const shimPath = resolve(dir, 'db-shim-feed.mjs')
writeFileSync(shimPath, `
export function db() { return globalThis.__pg }
export async function ensureSchema() {}
`)

process.env.SESSION_SECRET = 'test-secret-for-feed-check'
process.env.TRACK_TEST_DEVICES = ''

const bundle = await esbuild.build({
  entryPoints: ['netlify/functions/track-feed.mts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  external: ['tz-lookup'],
  plugins: [
    {
      name: 'swap-db',
      setup(build) {
        build.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath }))
      },
    },
  ],
})
const outPath = join(dir, 'track-feed.mjs')
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
  create table viewers (
    email text primary key, role text not null default 'pending',
    email_pref text not null default 'daily',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    granted_by text
  );
  create table sent_emails (
    local_date date not null, kind text not null default 'daily',
    sent_at timestamptz not null default now(),
    recipients int not null default 0, subject text,
    primary key (local_date, kind)
  );
`)
await pg.query(`insert into viewers (email, role) values ('owner@example.com', 'owner')`)

// Two days of riding near Logroño, so "today" and "everything" are different
// numbers and a query that forgets to filter by date cannot pass by accident.
//
// Yesterday climbs hard and comes back down; today has barely started. Any
// figure labelled "today" that includes yesterday's climbing will show it.
const LON = -2.45
const LAT = 42.46

// Minutes rather than hours: make_interval's arguments are integers, and a
// fractional hour arrives as text and fails to parse.
async function fix(minutesAgo, i, alt) {
  await pg.query(
    `insert into locations (device, tst, lat, lon, alt, acc, vel, batt, source, raw)
     values ('phone', now() - make_interval(mins => $1), $2, $3, $4, 10, 5, 80, 'device', '{}'::jsonb)`,
    [Math.round(minutesAgo), LAT + i * 0.002, LON + i * 0.002, alt],
  )
}

// Yesterday: 40 fixes, up 600 m and back down. Placed a day and a half back so
// they land outside today's local date in any timezone this fixture can pick.
for (let i = 0; i < 40; i++) {
  const alt = 400 + (i < 20 ? i * 30 : (39 - i) * 30)
  await fix(36 * 60 - i * 12, i, alt)
}
// Today: a real climb of about 300 m, over enough fixes that the smoothing and
// the hysteresis have something to work with. Without a climb today the "gain"
// assertion below passes on zero and proves nothing.
for (let i = 0; i < 30; i++) {
  await fix(300 - i * 9, 40 + i, 400 + i * 10)
}

globalThis.__pg = tagged
const { default: handler } = await import(pathToFileURL(outPath).href)

const { createSession } = await import(
  pathToFileURL(resolve('node_modules/.p7-sql-check/session.mjs')).href
).catch(async () => {
  await esbuild.build({
    entryPoints: ['netlify/lib/session.mts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: 'node_modules/.p7-sql-check/session.mjs',
  })
  return import(pathToFileURL(resolve('node_modules/.p7-sql-check/session.mjs')).href)
})

const { value } = createSession('owner@example.com')
const res = await handler(
  new Request('https://project7.bike/api/track', {
    headers: { cookie: `p7_session=${encodeURIComponent(value)}` },
  }),
)

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

check('handler returns 200', res.status === 200, `HTTP ${res.status}`)
const body = await res.json()

check('every query in the request path ran', !body.error, body.error ?? 'no error')
check('latest fix present', Boolean(body.latest))
check('trail drawn', Array.isArray(body.trail) && body.trail.length > 0, `${body.trail?.length} points`)
check('timezone resolved', Boolean(body.timezone), body.timezone)
check('total distance covers both days', body.distanceKm > body.distanceTodayKm,
  `${body.distanceKm?.toFixed(1)} km total vs ${body.distanceTodayKm?.toFixed(1)} km today`)

// The bug this file was written for: gain was computed over all history while
// labelled as today's. Today climbs about 290 m and yesterday another 570, so a
// query missing its date filter lands near 860 and cannot slip through.
check('gain today sees today\'s climb', body.elevationGainM > 150, `${Math.round(body.elevationGainM)} m`)
check("gain today excludes yesterday's climbing", body.elevationGainM < 450,
  `${Math.round(body.elevationGainM)} m`)
check('profile is today only', body.profileToday.length > 0, `${body.profileToday.length} samples`)
check('per-day summaries built', body.days.length >= 1, `${body.days.length} days`)

console.log(failures === 0 ? '\nAll feed SQL checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
