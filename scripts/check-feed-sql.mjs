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

/** Every statement the feed runs, so a test can assert what it reads. */
const executed = []

function tagged(strings, ...values) {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
    '',
  )
  executed.push(text)
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

const historyBundle = await esbuild.build({
  entryPoints: ['netlify/functions/track-history.mts'],
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
const historyPath = join(dir, 'track-history.mjs')
writeFileSync(historyPath, historyBundle.outputFiles[0].text)

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
    first_name text, last_name text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    granted_by text
  );
  create table day_rollups (
    local_date date not null, mode text not null, zone text not null,
    distance_m double precision not null, elapsed_s double precision not null,
    fixes int not null,
    start_lon double precision not null, start_lat double precision not null,
    end_lon double precision not null, end_lat double precision not null,
    gain_m double precision not null, net_m double precision,
    high_m double precision, low_m double precision,
    reconstructed boolean not null default false,
    computed_at timestamptz not null default now(),
    primary key (local_date, mode)
  );
  create table trail_cache (
    mode text primary key,
    through_date date not null,
    points jsonb not null,
    seen_received timestamptz not null,
    computed_at timestamptz not null default now()
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
check('today is drawn', Array.isArray(body.trail) && body.trail.length > 0, `${body.trail?.length} points`)
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
check('today comes back as a day summary', Boolean(body.today), body.today?.date)
check('the live feed carries a history version', typeof body.historyVersion === 'string',
  body.historyVersion)

// The whole point of the split: the journey so far must not be in here. The
// fields survive one release empty, so a viewer mid-session keeps a map rather
// than getting an error page from the bundle they are still running.
check('the live feed no longer carries finished days', body.days.length === 0)
check('nor the route behind him', body.backfillTrail.length === 0)


// ── The cost of a poll must not grow with the length of the trip ────────────
//
// The reason this file exists twice over: correctness alone would not notice
// the feed quietly going back to reading every fix ever recorded on every
// request, which is what made the database the largest line on the bill.

/** A fresh copy of the module, so its in-memory payload cache starts empty. */
let instance = 0
async function freshHandler() {
  const mod = await import(`${pathToFileURL(outPath).href}?i=${++instance}`)
  return mod.default
}

const poll = async (h) => {
  executed.length = 0
  const r = await h(
    new Request('https://project7.bike/api/track', {
      headers: { cookie: `p7_session=${encodeURIComponent(value)}` },
    }),
  )
  return { body: await r.json(), sql: [...executed] }
}

// The rebuild is recognisable by a CTE only it uses.
const isRebuild = (q) => q.includes('first_fix as (')
const readsLocations = (q) => /from locations/.test(q)
const isBounded = (q) =>
  /tst >= \$/.test(q) ||
  /max\(tst\)/.test(q) ||
  /received_at > \$/.test(q) ||
  /source = 'backfill'/.test(q) ||
  // Newest-fix lookups: one row off the (source, tst desc) index, however long
  // the table gets.
  /order by tst desc\s+limit 1/.test(q)

const second = await poll(handler)
check('a repeat poll rebuilds nothing', second.sql.filter(isRebuild).length === 0,
  `${second.sql.filter(isRebuild).length} rebuild(s)`)

const unbounded = second.sql.filter((q) => readsLocations(q) && !isBounded(q))
check('a repeat poll never scans the history', unbounded.length === 0,
  unbounded.map((q) => q.trim().slice(0, 60).replace(/\s+/g, ' ')).join(' | ') || 'none')

// A new fix arrives: the payload must update without touching finished days.
await fix(0, 71, 700)
const afterFix = await poll(await freshHandler())
check('a new fix invalidates the cached payload',
  afterFix.body.countToday > second.body.countToday,
  `${second.body.countToday} -> ${afterFix.body.countToday}`)
check('and still rebuilds nothing', afterFix.sql.filter(isRebuild).length === 0)
const unbounded2 = afterFix.sql.filter((q) => readsLocations(q) && !isBounded(q))
check('and still never scans the history', unbounded2.length === 0,
  unbounded2.map((q) => q.trim().slice(0, 60).replace(/\s+/g, ' ')).join(' | ') || 'none')

// ── Finished days are stored, not recomputed ────────────────────────────────
const stored = await pg.query('select * from day_rollups order by local_date')
check('finished days are summarised in the database', stored.rows.length >= 1,
  `${stored.rows.length} day(s) stored`)
check('today is not stored as finished',
  !stored.rows.some((r) => r.local_date.toISOString().slice(0, 10) === afterFix.body.today.date),
  stored.rows.map((r) => r.local_date.toISOString().slice(0, 10)).join(', '))

// ── A fix that arrives late for a finished day is picked up ────────────────
//
// OwnTracks replays what it queued during a gap in coverage, so yesterday can
// gain fixes today. A summary that never noticed would be wrong forever.
const historyOf = async (h) => {
  const r = await h(
    new Request('https://project7.bike/api/track/history', {
      headers: { cookie: `p7_session=${encodeURIComponent(value)}` },
    }),
  )
  return r.json()
}

const { default: historyHandler } = await import(pathToFileURL(historyPath).href)
let freshHistory = 0
const freshHistoryHandler = async () =>
  (await import(`${pathToFileURL(historyPath).href}?i=${++freshHistory}`)).default

const firstHistory = await historyOf(historyHandler)
check('the history endpoint returns the finished days', firstHistory.days.length >= 1,
  `${firstHistory.days.length} day(s)`)
check('and the route behind him', firstHistory.trail.length > 0,
  `${firstHistory.trail.length} points`)
check('and its version matches the live feed', firstHistory.version === afterFix.body.historyVersion)

const before = firstHistory.days[0].distanceKm
await pg.query(
  `insert into locations (device, tst, lat, lon, alt, source, raw, received_at)
   values ('phone', now() - make_interval(mins => $1), $2, $3, 400, 'device', '{}'::jsonb, now())`,
  [36 * 60 + 30, LAT + 0.5, LON + 0.5],
)
const late = await poll(await freshHandler())
check('a late fix for a finished day forces a rebuild', late.sql.filter(isRebuild).length === 1,
  `${late.sql.filter(isRebuild).length} rebuild(s)`)
const lateHistory = await historyOf(await freshHistoryHandler())
check('and the stored summary is corrected', lateHistory.days[0].distanceKm > before,
  `${before.toFixed(1)} -> ${lateHistory.days[0].distanceKm.toFixed(1)} km`)
check('and the version changes so a client refetches',
  lateHistory.version !== firstHistory.version)

// ── The totals still agree with reading every fix the simple way ───────────
const independent = await pg.query(`
  with ordered as (
    select tst, lat, lon,
      lag(lat) over (order by tst) as plat,
      lag(lon) over (order by tst) as plon
    from locations where source = 'device'
  )
  select coalesce(sum(
    case when plat is null then 0 else
      2 * 6371000 * asin(least(1, sqrt(
        power(sin(radians(lat - plat) / 2), 2) +
        cos(radians(plat)) * cos(radians(lat)) *
        power(sin(radians(lon - plon) / 2), 2)
      )))
    end), 0) / 1000.0 as km
  from ordered
`)
const expected = Number(independent.rows[0].km)
check('the split total matches a plain full-history sum',
  Math.abs(late.body.distanceKm - expected) < 0.01,
  `feed ${late.body.distanceKm.toFixed(3)} km vs ${expected.toFixed(3)} km`)


// ── Crossing a timezone re-buckets the days ────────────────────────────────
//
// The trip flies between continents. Day boundaries fall at different instants
// in a new zone, so stored days bucketed in the old one would no longer meet
// today where today now starts — and the fixes in the overlap would be counted
// twice. Riding east is the dangerous direction, so the fixture flies east.
await pg.query(
  `insert into locations (device, tst, lat, lon, alt, source, raw)
   values ('phone', now(), 43.238949, 76.889709, 800, 'device', '{}'::jsonb)`,
)
const moved = await poll(await freshHandler())
check('a new timezone is noticed', moved.body.timezone === 'Asia/Almaty', moved.body.timezone)
check('and forces the days to be re-bucketed', moved.sql.filter(isRebuild).length === 1,
  `${moved.sql.filter(isRebuild).length} rebuild(s)`)

const afterMove = await pg.query(`
  with ordered as (
    select tst, lat, lon,
      lag(lat) over (order by tst) as plat,
      lag(lon) over (order by tst) as plon
    from locations where source = 'device'
  )
  select coalesce(sum(
    case when plat is null then 0 else
      2 * 6371000 * asin(least(1, sqrt(
        power(sin(radians(lat - plat) / 2), 2) +
        cos(radians(plat)) * cos(radians(lat)) *
        power(sin(radians(lon - plon) / 2), 2)
      )))
    end), 0) / 1000.0 as km
  from ordered
`)
check('nothing is double counted across the boundary',
  Math.abs(moved.body.distanceKm - Number(afterMove.rows[0].km)) < 0.01,
  `feed ${moved.body.distanceKm.toFixed(1)} km vs ${Number(afterMove.rows[0].km).toFixed(1)} km`)


// ── The stored line still follows the road ─────────────────────────────────
//
// Thinning by distance is what makes a route stop tracing the road it was
// ridden on: it drops the apex of every switchback because it cannot tell a
// corner from a straight. The simplification has to spend its points where the
// road bends.
const simplifyBundle = await esbuild.build({
  entryPoints: ['netlify/lib/rollups.mts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'swap-db', setup(b) { b.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath })) } }],
})
writeFileSync(join(dir, 'rollups.mjs'), simplifyBundle.outputFiles[0].text)
const { simplify } = await import(pathToFileURL(resolve(dir, 'rollups.mjs')).href)

const DEG = 1 / 111320
const road = []
for (let d = 0; d < 40000; d += 150) road.push([0, d * DEG])
for (let d = 0; d < 10000; d += 150) road.push([Math.sin(d / 300) * 120 * DEG, (40000 + d) * DEG])

const kept = simplify(road, 12)
const bends = kept.filter((p) => p[1] > 40000 * DEG).length
const straight = kept.length - bends
check('a straight run costs almost nothing', straight <= 4, `${straight} points for 40 km`)
check('the switchbacks keep their shape', bends >= 20, `${bends} points for 10 km`)
check('and the whole thing is a fraction of the fixes', kept.length < road.length / 4,
  `${kept.length} of ${road.length}`)


// ── What actually goes over the wire, every thirty seconds ─────────────────
const livePayload = JSON.stringify(late.body)
const historyPayload = JSON.stringify(lateHistory)
const kb = (t) => (t.length / 1024).toFixed(1)
console.log(`\n      live poll: ${kb(livePayload)} KB   history (once a session): ${kb(historyPayload)} KB`)
check('the live poll carries no route history',
  late.body.days.length === 0 && late.body.backfillTrail.length === 0 &&
  livePayload.length < 20_000, `${kb(livePayload)} KB`)

console.log(failures === 0 ? '\nAll feed SQL checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
