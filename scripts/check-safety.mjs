/**
 * Runs the safety check against a real Postgres, through a scripted day.
 *
 * John rides from Sarymay towards Gazli, goes quiet mid-afternoon, turns up
 * again, then stops moving. The owners should hear about each of those once,
 * and about nothing else — not lunch, not the morning before he sets off, not
 * the night, not the last few kilometres into town.
 *
 * Time is passed in rather than read off the clock, so the day can be played
 * forward and the suite gives the same answer at any hour it is run.
 *
 *   npm run check-safety
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()
const executed = []
globalThis.__pg = (strings, ...values) => {
  const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '')
  executed.push(text)
  return pg.query(text, values).then((r) => r.rows)
}

const dir = 'node_modules/.p7-sql-check'
mkdirSync(dir, { recursive: true })
const shimPath = resolve(dir, 'db-shim-safety.mjs')
writeFileSync(shimPath, `
export function db() { return globalThis.__pg }
export async function ensureSchema() {}
`)

await pg.exec(`
  create table locations (
    id bigserial primary key, device text not null, tst timestamptz not null,
    lat double precision not null, lon double precision not null,
    acc double precision, alt double precision, vel double precision,
    cog double precision, batt smallint, bs smallint, conn text, tid text,
    source text not null default 'device', raw jsonb not null default '{}'::jsonb,
    received_at timestamptz not null default now(),
    constraint locations_device_tst_key unique (device, tst)
  );
  create table viewers (
    email text primary key, role text not null default 'pending',
    email_pref text not null default 'daily', first_name text, last_name text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    granted_by text
  );
  create table route_days (
    date date primary key, kind text not null,
    from_place text, to_place text, miles double precision, note text,
    from_lon double precision, from_lat double precision,
    to_lon double precision, to_lat double precision,
    cycling_miles double precision, route_coords jsonb, profile text,
    needs_review boolean not null default false,
    updated_by text, updated_at timestamptz not null default now()
  );
  create table safety_alerts (
    id bigserial primary key, local_date date not null, kind text not null,
    lat double precision not null, lon double precision not null,
    last_fix timestamptz not null, detail text,
    sent_at timestamptz not null default now(), resolved_at timestamptz
  );
  insert into viewers (email, role) values
    ('alex@example.com', 'owner'), ('john@example.com', 'owner'), ('fan@example.com', 'viewer');
`)

process.env.RESEND_API_KEY = 're_test'
process.env.TRACK_TEST_DEVICES = ''
const sent = []
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.resend.com')) throw new Error(`unexpected fetch: ${url}`)
  const batch = JSON.parse(init.body)
  sent.push(...batch)
  return new Response(JSON.stringify({ data: batch.map((_, i) => ({ id: `msg_${sent.length + i}` })) }), { status: 200 })
}

const built = await esbuild.build({
  entryPoints: ['netlify/lib/safety.mts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'swap-db', setup(b) { b.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath })) } }],
})
const outPath = join(dir, 'safety.mjs')
writeFileSync(outPath, built.outputFiles[0].text)
const { runSafetyCheck } = await import(pathToFileURL(resolve(outPath)).href)

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Sarymay to Gazli, on 11 November. Tashkent time is UTC+5, so 03:00 UTC is
// eight in the morning where he is.
const SARYMAY = [61.9127, 41.0577]
const GAZLI = [63.454, 40.1339]
await pg.query(`insert into route_days (date, kind, from_place, to_place, from_lon, from_lat, to_lon, to_lat, profile)
  values ('2026-11-11', 'ride', 'Sarymay', 'Gazli', $1, $2, $3, $4, 'driving')`, [...SARYMAY, ...GAZLI])

const at = (utc) => new Date(`2026-11-11T${utc}:00Z`)
const along = (f) => [SARYMAY[0] + (GAZLI[0] - SARYMAY[0]) * f, SARYMAY[1] + (GAZLI[1] - SARYMAY[1]) * f]
async function fix(utc, [lon, lat], batt = 64, conn = 'm') {
  await pg.query(
    `insert into locations (device, tst, lat, lon, batt, conn) values ('phone', $1, $2, $3, $4, $5)
     on conflict do nothing`,
    [`2026-11-11T${utc}:00Z`, lat, lon, batt, conn],
  )
}
const minutes = (from, n, step = 5) =>
  Array.from({ length: n }, (_, i) => {
    const total = from + i * step
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  })

// ── Before he sets off ─────────────────────────────────────────────────────
for (const t of minutes(3 * 60, 6)) await fix(t, along(0))
let r = await runSafetyCheck({ now: at('05:00') })
check('a morning spent in the guesthouse is not an alert', r.action === 'nothing', r.reason)

// ── Riding, then lunch ─────────────────────────────────────────────────────
// Out at 08:30 his time, 0.55 of the way by 12:00, then an hour at a café.
const ride = minutes(3 * 60 + 30, 43)
for (const [i, t] of ride.entries()) await fix(t, along((i / ride.length) * 0.55))
const cafe = along(0.55)
for (const t of minutes(7 * 60 + 5, 12)) await fix(t, cafe)
r = await runSafetyCheck({ now: at('08:00') })
check('an hour at lunch is not an alert', r.action === 'nothing', `${r.reason}; still ${r.observed?.stillForMinutes} min`)
check('and the check saw him on the road to Gazli', r.observed?.destination === 'Gazli' && r.observed.toDestinationKm > 50,
  `${r.observed?.toDestinationKm} km to ${r.observed?.destination}`)

// ── Gone quiet ─────────────────────────────────────────────────────────────
// Back on the road at 13:00, one more fix at 13:10, then nothing.
await fix('08:05', along(0.56), 31, 'o')
await fix('08:10', along(0.57), 31, 'o')
r = await runSafetyCheck({ now: at('09:00'), dryRun: true })
check('fifty minutes without a fix is not yet an alert', r.action === 'nothing', r.reason)

executed.length = 0
r = await runSafetyCheck({ now: at('09:20'), dryRun: true })
check('a dry run says what it would send', r.action === 'alerted' && r.kind === 'quiet' && r.reason.startsWith('dry run'), r.reason)
check('and sends and records nothing', sent.length === 0 &&
  (await pg.query('select count(*)::int as n from safety_alerts')).rows[0].n === 0)
const unbounded = executed.filter((q) => /from locations/.test(q) && !/tst >= \$/.test(q) && !/order by tst desc\s+limit 1/.test(q))
check('no read of locations is unbounded', unbounded.length === 0,
  unbounded.map((q) => q.trim().slice(0, 60).replace(/\s+/g, ' ')).join(' | ') || 'none')

r = await runSafetyCheck({ now: at('09:20') })
check('seventy minutes without a fix, far from Gazli, alerts the owners', r.action === 'alerted' && r.kind === 'quiet', r.reason)
const quietMail = sent.slice()
check('only the owners', quietMail.map((m) => m.to[0]).sort().join() === 'alex@example.com,john@example.com',
  quietMail.map((m) => m.to[0]).join())
check('saying how long, and how far short', /no fix from John for 1 h 10 min/.test(quietMail[0]?.subject) &&
  quietMail[0]?.subject.includes('short of Gazli'), quietMail[0]?.subject)
check('with the phone as it last reported', quietMail[0]?.text.includes('battery 31%, with no connection'))
check('and where to look', quietMail[0]?.text.includes('google.com/maps?q='))

sent.length = 0
r = await runSafetyCheck({ now: at('09:35') })
check('and only once', r.action === 'nothing' && sent.length === 0, r.reason)

// ── He turns up ────────────────────────────────────────────────────────────
// The phone reconnects and sends what it recorded through the gap: he rode on.
const gap = minutes(8 * 60 + 15, 18)
for (const [i, t] of gap.entries()) await fix(t, along(0.57 + (i / gap.length) * 0.2), 22, 'm')
r = await runSafetyCheck({ now: at('09:45') })
check('fixes arriving again send the all-clear', r.action === 'cleared' && r.kind === 'quiet', r.reason)
check('saying it was the signal, not him', sent[0]?.subject.startsWith('All clear') &&
  sent[0]?.text.includes('so it was the signal'), sent[0]?.subject)
check('and the episode is closed', (await pg.query(`select count(*)::int as n from safety_alerts where resolved_at is null`)).rows[0].n === 0)

// ── Stopped ────────────────────────────────────────────────────────────────
// Then he stops, phone still reporting, for two hours and a quarter.
sent.length = 0
const stop = along(0.77)
for (const t of minutes(9 * 60 + 45, 28)) await fix(t, [stop[0] + 0.0004, stop[1]], 20, 'm')
r = await runSafetyCheck({ now: at('12:00') })
check('two hours in the same spot, short of town, alerts the owners', r.action === 'alerted' && r.kind === 'still',
  `${r.reason}; ${r.observed?.stillForMinutes} min`)
check('saying so in the subject', /hasn't moved for 2 h/.test(sent[0]?.subject ?? ''), sent[0]?.subject)

sent.length = 0
await fix('12:05', along(0.8))
r = await runSafetyCheck({ now: at('12:06') })
check('moving on clears it', r.action === 'cleared' && r.kind === 'still' && sent[0]?.subject === 'All clear: John is moving again',
  sent[0]?.subject)

// ── The last few kilometres ────────────────────────────────────────────────
sent.length = 0
await fix('12:40', [GAZLI[0] - 0.03, GAZLI[1]])
r = await runSafetyCheck({ now: at('14:30') })
check('quiet within 3 km of the night\'s town is arriving, not an alert', r.action === 'nothing' && sent.length === 0, r.reason)

// ── The night ──────────────────────────────────────────────────────────────
r = await runSafetyCheck({ now: at('18:30') })
check('after riding hours nothing is checked', r.action === 'skipped', r.reason)

// On a day the plan places him somewhere, a night run never touches the
// database — the same trick the morning email uses to keep it asleep.
executed.length = 0
r = await runSafetyCheck({ now: new Date('2026-10-30T21:00:00Z') })
check('a night run stops on the plan, without a query', r.action === 'skipped' && executed.length === 0,
  `${r.reason}; ${executed.length} quer(ies)`)

// ── A bad day cannot become a flood ────────────────────────────────────────
process.env.SAFETY_MAX_PER_DAY = '2'
sent.length = 0
await pg.query(`delete from locations where tst > '2026-11-11T12:05:00Z'`)
r = await runSafetyCheck({ now: at('13:30') })
check('past the day\'s allowance, nothing more is sent', r.action === 'nothing' && sent.length === 0, r.reason)
delete process.env.SAFETY_MAX_PER_DAY

process.env.SAFETY_PAUSED = '1'
r = await runSafetyCheck({ now: at('09:20') })
check('SAFETY_PAUSED holds everything', r.action === 'skipped', r.reason)
delete process.env.SAFETY_PAUSED

// ── A whole morning with nothing ───────────────────────────────────────────
// The next day nothing arrives at all. The other two alerts only watch once he
// has ridden 3 km today, so this is the case they could never see — and the
// day it was added, the last fix was 27 hours old and the check said "not set
// off".
{
  const BUKHARA = [64.4569, 39.7683]
  await pg.query(`insert into route_days (date, kind, from_place, to_place, from_lon, from_lat, to_lon, to_lat)
    values ('2026-11-12', 'ride', 'Gazli', 'Bukhara', $1, $2, $3, $4)`, [...GAZLI, ...BUKHARA])
  const next = (utc) => new Date(`2026-11-12T${utc}:00Z`)
  sent.length = 0

  r = await runSafetyCheck({ now: next('06:30') })
  check('a quiet morning is not an alert before noon', r.action === 'nothing' && sent.length === 0, r.reason)

  r = await runSafetyCheck({ now: next('07:05') })
  check('at noon on a riding day with no fix since midnight, the owners hear', r.action === 'alerted' && r.kind === 'silent',
    r.reason)
  check('saying so, and how old the last fix is', /no fix from John yet today — last one 1[89] h/.test(sent[0]?.subject ?? ''),
    sent[0]?.subject)
  check('naming the day of that fix', sent[0]?.text.includes('on Wednesday'), sent[0]?.text.split('\n')[2])
  check('without claiming a distance ridden today', !sent[0]?.text.includes('Ridden today'))

  sent.length = 0
  r = await runSafetyCheck({ now: next('07:20') })
  check('and once', r.action === 'nothing' && sent.length === 0, r.reason)

  await pg.query(`insert into locations (device, tst, lat, lon, batt, conn) values ('phone', $1, $2, $3, 80, 'm')`,
    ['2026-11-12T07:30:00Z', GAZLI[1], GAZLI[0] + 0.2])
  r = await runSafetyCheck({ now: next('07:35') })
  check('the first fix of the day clears it', r.action === 'cleared' && r.kind === 'silent' &&
    sent[0]?.subject === "All clear: John's fixes are coming in again", sent[0]?.subject)
}

console.log(failures === 0 ? '\nAll safety checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
