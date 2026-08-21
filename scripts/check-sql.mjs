/**
 * Runs the daily-email queries against a real Postgres before they ship.
 *
 * TypeScript cannot see inside a SQL template string, so a query that compiles
 * can still be broken — this project has shipped two of those. PGlite is a full
 * Postgres compiled to WebAssembly, so the parser and planner here are the same
 * ones Neon runs, without needing a server or a connection string.
 *
 * The point is that it exercises the real module. daily.mts is bundled with its
 * database import swapped for a shim that reproduces the one behaviour that
 * bites: the driver emits a separate placeholder for every interpolation, so
 * using the same value twice yields $1 and $2, not $1 twice.
 *
 *   node scripts/check-sql.mjs
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()

/** Mirrors @neondatabase/serverless: tagged template in, array of rows out. */
function tagged(strings, ...values) {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
    '',
  )
  return pg.query(text, values).then((r) => r.rows)
}

const shim = `
export function db() { return globalThis.__pg }
export async function ensureSchema() {}
`

// Inside node_modules rather than the system temp directory: the bundle keeps
// tz-lookup external, and an import only resolves from somewhere under the
// project root.
const dir = 'node_modules/.p7-sql-check'
mkdirSync(dir, { recursive: true })
const shimPath = resolve(dir, 'db-shim.mjs')
writeFileSync(shimPath, shim)

const bundle = await esbuild.build({
  entryPoints: ['netlify/lib/daily.mts'],
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

const outPath = join(dir, 'daily.mjs')
writeFileSync(outPath, bundle.outputFiles[0].text)

globalThis.__pg = tagged

// The schema as db.mts creates it, so a column added there but missed here
// shows up as a failure rather than passing quietly.
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
  create table destination_facts (
    destination text primary key, fact text not null,
    model text not null, created_at timestamptz not null default now()
  );
  create table sent_emails (
    local_date date not null, kind text not null default 'daily',
    sent_at timestamptz not null default now(),
    recipients int not null default 0, subject text,
    primary key (local_date, kind)
  );
`)

// A ride along a real leg, laid down over the last half hour so the freshness
// and movement gates see what they would see on a live morning.
//
// The leg is chosen as the riding day nearest today rather than the first one
// in the file. The matcher only considers legs within ten days of the date it
// is given, so a fixture pinned to the start of the trip quietly stops matching
// as the trip goes on — which is exactly what happened here.
const itinerary = JSON.parse(readFileSync('src/data/itinerary.json', 'utf8'))
const todayIso = new Date().toISOString().slice(0, 10)
const rideDays = itinerary.days.filter((d) => d.kind === 'ride' && d.fromCoords && d.toCoords)
const leg = rideDays.reduce((best, d) =>
  Math.abs(Date.parse(d.date) - Date.parse(todayIso)) <
  Math.abs(Date.parse(best.date) - Date.parse(todayIso))
    ? d
    : best,
)
const [lon0, lat0] = leg.fromCoords
const [lon1, lat1] = leg.toCoords

for (let i = 0; i < 12; i++) {
  const f = i / 40
  await pg.query(
    `insert into locations (device, tst, lat, lon, alt, source, raw)
     values ($1, now() - make_interval(mins => $2), $3, $4, 700, 'device', '{}'::jsonb)`,
    ['phone', (11 - i) * 3, lat0 + (lat1 - lat0) * f, lon0 + (lon1 - lon0) * f],
  )
}
await pg.query(`insert into viewers (email, role) values ('a@example.com', 'owner')`)
await pg.query(`insert into viewers (email, role) values ('b@example.com', 'viewer')`)
await pg.query(`insert into viewers (email, role, email_pref) values ('c@example.com', 'viewer', 'none')`)
await pg.query(`insert into viewers (email, role) values ('d@example.com', 'pending')`)

process.env.SESSION_SECRET ??= 'test-secret-for-sql-check'

const { runDailyEmail } = await import(pathToFileURL(outPath).href)

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// force skips the clock and movement gates, which cannot be satisfied on demand
// — the fixture cannot be riding at 7am in his timezone on every machine. Every
// query still runs, which is what is being verified.
const forced = await runDailyEmail({ force: true, dryRun: true, origin: 'https://example.test' })
check('all queries execute', forced.reason.startsWith('dry run'), forced.reason)
check('subject built', Boolean(forced.subject), forced.subject)
check(
  'only subscribed viewers and owners',
  JSON.stringify(forced.recipients) === JSON.stringify(['a@example.com', 'b@example.com']),
  JSON.stringify(forced.recipients),
)
check('unsubscribe link is per recipient', forced.preview?.html.includes('/api/unsubscribe?t='))
check('map omitted when no token', !forced.preview?.html.includes('api.mapbox.com'))

process.env.VITE_MAPBOX_TOKEN = 'pk.test'
const withMap = await runDailyEmail({ force: true, dryRun: true })
check('map included when a token is set', withMap.preview?.html.includes('api.mapbox.com'))

// The clock gate, at whatever hour this happens to run.
const unforced = await runDailyEmail({ dryRun: true })
check(
  'a gate stops the unforced run',
  unforced.sent === false && !unforced.reason.startsWith('dry run'),
  unforced.reason,
)

await pg.query(`update viewers set email_pref = 'none'`)
const nobody = await runDailyEmail({ force: true, dryRun: true })
check('no subscribers is a clean stop', nobody.reason === 'nobody is subscribed', nobody.reason)
await pg.query(`update viewers set email_pref = 'daily' where role in ('owner','viewer')`)

// The already-sent gate, with the clock opened right up so that it, rather
// than the hour, is what stops the run.
process.env.EMAIL_SEND_FROM_HOUR = '0'
process.env.EMAIL_SEND_UNTIL_HOUR = '23'
const open = await runDailyEmail({ dryRun: true })
check('an open window reaches the render step', open.reason.startsWith('dry run'), open.reason)

await pg.query(`insert into sent_emails (local_date, kind) values ($1, 'daily')`, [open.localDate])
const repeat = await runDailyEmail({ dryRun: true })
check('already-sent day is refused', repeat.reason.startsWith('already sent'), repeat.reason)

// And the claim itself: a second run cannot take a day the first one holds.
await pg.query(`delete from sent_emails`)
process.env.RESEND_API_KEY = 'test-key-not-used'
const claimed = await pg.query(
  `insert into sent_emails (local_date, kind, recipients, subject)
   values ($1, 'daily', 2, 'first') on conflict (local_date, kind) do nothing
   returning local_date`,
  [open.localDate],
)
check('first claim wins', claimed.rows.length === 1)
const second = await pg.query(
  `insert into sent_emails (local_date, kind, recipients, subject)
   values ($1, 'daily', 2, 'second') on conflict (local_date, kind) do nothing
   returning local_date`,
  [open.localDate],
)
check('second claim is refused', second.rows.length === 0)

console.log(failures === 0 ? '\nAll SQL checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
