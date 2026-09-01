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
    destination text primary key, fact text,
    model text not null,
    distance_line text, distance_miles double precision,
    format_version int not null default 1, attempts int not null default 0,
    declined_at timestamptz, created_at timestamptz not null default now()
  );
  create table route_days (
    date date primary key, kind text not null,
    from_place text, to_place text, miles double precision, note text,
    from_lon double precision, from_lat double precision,
    to_lon double precision, to_lat double precision,
    cycling_miles double precision, route_coords jsonb,
    needs_review boolean not null default false,
    updated_by text, updated_at timestamptz not null default now()
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

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  // The v6 reverse shape country.mts actually reads.
  if (href.includes('api.mapbox.com/search/geocode')) {
    return new Response(
      JSON.stringify({
        features: [
          { properties: { name: 'France', context: { country: { name: 'France', country_code: 'fr' } } } },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  if (href.includes('api.mapbox.com/directions')) {
    return new Response(
      JSON.stringify({ code: 'Ok', routes: [{ distance: 96_000, geometry: { coordinates: [[1.1, 44.1], [2.2, 45.2]] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  if (href.includes('api.resend.com')) {
    return new Response(JSON.stringify({ id: 'test-message-id' }), { status: 200 })
  }
  return realFetch(url, init)
}

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

// ── The map's pins agree with the header ───────────────────────────────────
// These came from different places once John could edit his own route: the
// header read the live route while the start pin read the plan, so an email
// went out headed "Saint-Marcellin → Albertville" with its A pin on Chambéry.
//
// The rerouted start is nudged rather than moved across France, because the leg
// matcher still has to recognise where the fixture is riding.
const movedFrom = [Number((lon0 + 0.02).toFixed(4)), Number((lat0 + 0.02).toFixed(4))]
await pg.query(
  `insert into route_days (date, kind, from_place, to_place, from_lon, from_lat, to_lon, to_lat, miles)
   values ($1::date, 'ride', 'Rerouted Start', 'Rerouted End', $2, $3, $4, $5, 60)
   on conflict (date) do update set
     from_place = excluded.from_place, to_place = excluded.to_place,
     from_lon = excluded.from_lon, from_lat = excluded.from_lat,
     to_lon = excluded.to_lon, to_lat = excluded.to_lat, miles = excluded.miles`,
  [leg.date, movedFrom[0], movedFrom[1], lon1, lat1],
)

const rerouted = await runDailyEmail({ force: true, dryRun: true })
const reroutedHtml = rerouted.preview?.html ?? ''
check('an edited route reaches the email header',
  reroutedHtml.includes('Rerouted Start') && reroutedHtml.includes('Rerouted End'),
  rerouted.subject)
check('and the map pin moves with it',
  reroutedHtml.includes(movedFrom[0].toFixed(4)),
  `expected ${movedFrom[0].toFixed(4)} in the map url`)
check('rather than staying on the planned start',
  !reroutedHtml.includes(`(${lon0.toFixed(4)},${lat0.toFixed(4)})`),
  `planned start ${lon0.toFixed(4)},${lat0.toFixed(4)} should not be pinned`)
check('and his own distance is what is shown', rerouted.subject?.includes('60 miles'),
  rerouted.subject)

// ── The country is named ───────────────────────────────────────────────────
// Nobody outside France has heard of Saint-Marcellin.
check('the country is named in the body', reroutedHtml.includes('France'),
  (reroutedHtml.match(/Day \d+ &middot; [^<]*/) || [''])[0].slice(0, 80))
check('and in the plain text part', (rerouted.preview?.text ?? '').includes('France'))

// Put it back, so the gates below are tested against the plan as before.
await pg.query('delete from route_days')

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

// ── Sending a morning the schedule missed ──────────────────────────────────
// The gates can only ever decide not to send, so a day skipped at 7am because
// he had not set off yet stayed skipped once the window closed. A broadcast is
// an owner overruling that, and it has to reach the real list, record the day,
// and then leave nothing for the schedule to send a second time.
await pg.query(`delete from sent_emails`)

// Everyone whose pref is 'daily' — c was switched back on further up.
const subscribers = ['a@example.com', 'b@example.com', 'c@example.com']

const posted = []
const sendingFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (href.includes('api.resend.com')) {
    posted.push(...JSON.parse(init.body))
    return new Response(JSON.stringify({ data: [{ id: 'broadcast-id' }] }), { status: 200 })
  }
  return sendingFetch(url, init)
}
const addressed = () => posted.map((m) => m.to[0])

const cast = await runDailyEmail({ broadcast: true, origin: 'https://example.test' })
check('a broadcast sends', cast.sent === true, cast.reason)
check(
  'to the whole subscriber list, not just the owner',
  JSON.stringify(addressed()) === JSON.stringify(subscribers),
  JSON.stringify(addressed()),
)
// One message each rather than one message bcc'd to everybody, because the
// unsubscribe link only means anything if it is that reader's own.
const unsubscribes = new Set(posted.map((m) => m.headers?.['List-Unsubscribe']))
check('each carrying its own unsubscribe link', unsubscribes.size === subscribers.length,
  `${unsubscribes.size} distinct link(s) for ${subscribers.length} recipients`)

const recorded = await pg.query(`select recipients, subject from sent_emails where local_date = $1`, [
  cast.localDate,
])
check('and the day is recorded as sent', recorded.rows.length === 1, JSON.stringify(recorded.rows[0]))
check(
  'with what actually went out',
  recorded.rows[0]?.recipients === subscribers.length && recorded.rows[0]?.subject === cast.subject,
  JSON.stringify(recorded.rows[0]),
)

// The point of recording it: the hourly schedule must not now send it again.
const afterCast = await runDailyEmail({ dryRun: true })
check('so the schedule will not send it again', afterCast.reason.startsWith('already sent'), afterCast.reason)

// A day claimed by a run whose send then failed is exactly the day that most
// needs sending. The claim is what a broadcast overrules, not what stops it.
await pg.query(`update sent_emails set subject = 'claimed but never sent', recipients = 0`)
posted.length = 0
const recovered = await runDailyEmail({ broadcast: true, origin: 'https://example.test' })
check('a claimed-but-unsent day can still be broadcast', recovered.sent === true, recovered.reason)
check('reaching everybody', JSON.stringify(addressed()) === JSON.stringify(subscribers),
  JSON.stringify(addressed()))
const rewritten = await pg.query(`select recipients, subject from sent_emails where local_date = $1`, [
  cast.localDate,
])
check(
  'and the record is rewritten rather than left stale',
  rewritten.rows[0]?.subject === recovered.subject &&
    rewritten.rows[0]?.recipients === subscribers.length,
  JSON.stringify(rewritten.rows[0]),
)

// A test send is still one address and still leaves the day unclaimed, so it
// cannot be mistaken for the morning's send.
await pg.query(`delete from sent_emails`)
posted.length = 0
const mine = await runDailyEmail({ force: true, onlyTo: 'a@example.com' })
check('a test send goes to one address',
  JSON.stringify(addressed()) === JSON.stringify(['a@example.com']), JSON.stringify(addressed()))
const afterTest = await pg.query(`select 1 from sent_emails`)
check('and does not claim the day', afterTest.rows.length === 0)
check('so the real send can still happen', mine.sent === true, mine.reason)

globalThis.fetch = sendingFetch

console.log(failures === 0 ? '\nAll SQL checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
