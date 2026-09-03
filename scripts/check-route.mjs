/**
 * The route John edits from the road, checked against a real Postgres.
 *
 * The thing worth protecting here is the separation: `itinerary.json` is the
 * plan he set out with and the only thing "a day behind schedule" can honestly
 * be measured against, while the table is where he actually went. If an edit
 * ever reaches the plan, that figure quietly becomes zero forever and nobody
 * would notice, because the number would still look plausible.
 *
 *   npm run check-route
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()
function tagged(strings, ...values) {
  const text = strings.reduce((a, p, i) => a + p + (i < values.length ? `$${i + 1}` : ''), '')
  return pg.query(text, values).then((r) => r.rows)
}

const dir = 'node_modules/.p7-sql-check'
mkdirSync(dir, { recursive: true })
const shimPath = resolve(dir, 'db-shim-route.mjs')
writeFileSync(shimPath, `
export function db() { return globalThis.__pg }
export async function ensureSchema() {}
`)

await pg.exec(`
  create table route_days (
    date date primary key, kind text not null,
    from_place text, to_place text, miles double precision, note text,
    from_lon double precision, from_lat double precision,
    to_lon double precision, to_lat double precision,
    cycling_miles double precision, route_coords jsonb,
    needs_review boolean not null default false,
    updated_by text, updated_at timestamptz not null default now()
  );
`)
globalThis.__pg = tagged

// Mapbox directions, stubbed. Real ones cost a call and a second and would make
// this test depend on the weather in Ardèche.
let directionsCalls = 0
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.mapbox.com/directions')) throw new Error(`unexpected fetch: ${url}`)
  directionsCalls++
  // A road that bends, not a ruler: a straight line simplifies to two points
  // and would let a broken thinner pass.
  const coords = Array.from({ length: 500 }, (_, i) => [
    3.3 + i * 0.002,
    44.4 + i * 0.0004 + Math.sin(i / 7) * 0.01,
  ])
  return new Response(
    JSON.stringify({ code: 'Ok', routes: [{ distance: 114_000, geometry: { coordinates: coords } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
process.env.VITE_MAPBOX_TOKEN = 'pk.test'

const bundle = await esbuild.build({
  entryPoints: ['netlify/lib/route.mts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'swap-db', setup(b) { b.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath })) } }],
})
const outPath = join(dir, 'route.mjs')
writeFileSync(outPath, bundle.outputFiles[0].text)
const { loadRoute, saveDay, rechainNextDay, lineForEmail, lineForMap, PLAN } =
  await import(pathToFileURL(resolve(outPath)).href)

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const dayOn = async (date) => (await loadRoute()).find((d) => d.date === date)

// ── With nothing edited, the route is the plan ─────────────────────────────
const planDay = PLAN.find((d) => d.kind === 'ride' && d.to)
check('an unedited route is the plan itself', (await loadRoute()).length === PLAN.length)
check('day for day', (await dayOn(planDay.date))?.to === planDay.to, planDay.to)
check('and nothing is marked as edited', (await dayOn(planDay.date))?.edited !== true)

// ── An edit wins for that day and no other ─────────────────────────────────
const target = PLAN.find((d) => d.kind === 'ride' && d.to && d.fromCoords && d.toCoords)
const before = { ...target }
await saveDay({
  date: target.date, kind: 'ride',
  from: before.from, fromCoords: before.fromCoords,
  to: 'Chanac', toCoords: [3.344524, 44.465214],
  miles: 82, note: 'Stopped short', needsReview: false,
}, 'owner@example.com')

const edited = await dayOn(target.date)
check('the edited day changes', edited.to === 'Chanac', `${before.to} -> ${edited.to}`)
check('his distance is kept', edited.miles === 82)
check('the road\'s own distance is recorded beside it', Math.round(edited.cyclingMiles) === 71)
check('it is marked as edited', edited.edited === true)
check('with who and when', edited.editedBy === 'owner@example.com' && Boolean(edited.editedAt))
check('the day before is untouched',
  (await loadRoute()).find((d) => d.date < target.date && d.kind === 'ride')?.edited !== true)

// ── The plan is never written to ───────────────────────────────────────────
// The whole reason the two exist separately: drift is measured against the
// plan, so an edit reaching it would silently zero that figure forever.
const planNow = JSON.parse(readFileSync('src/data/itinerary.json', 'utf8'))
check('the plan file still says what it always said',
  planNow.days.find((d) => d.date === target.date).to === before.to,
  `${planNow.days.find((d) => d.date === target.date).to} on disk`)
check('and the loaded plan in memory is unchanged',
  PLAN.find((d) => d.date === target.date).to === before.to)

// ── A distance he does not give is taken from the road ─────────────────────
const nextRide = PLAN.find((d) => d.date > target.date && d.kind === 'ride' && d.toCoords)
await saveDay({
  date: nextRide.date, kind: 'ride',
  from: 'Chanac', fromCoords: [3.344524, 44.465214],
  to: nextRide.to, toCoords: nextRide.toCoords,
  miles: null, note: '', needsReview: false,
}, 'owner@example.com')
check('an unstated distance falls back to the road', (await dayOn(nextRide.date)).miles === 71)

// ── Rechaining moves the next day's origin ─────────────────────────────────
await saveDay({
  date: target.date, kind: 'ride',
  from: before.from, fromCoords: before.fromCoords,
  to: 'Aubenas', toCoords: [4.388357, 44.62072],
  miles: 78, note: '', needsReview: false,
}, 'owner@example.com')
const chained = await rechainNextDay(target.date, 'owner@example.com')
check('the following day now starts where this one ends', chained?.from === 'Aubenas')
check('and is flagged for review', chained?.needsReview === true)
check('but keeps its own destination', chained?.to === nextRide.to)

// ── Rest days are not routed ───────────────────────────────────────────────
const rest = PLAN.find((d) => d.kind === 'rest' && d.date > target.date)
directionsCalls = 0
await saveDay({
  date: rest.date, kind: 'rest', from: null, fromCoords: null,
  to: 'Aubenas', toCoords: [4.388357, 44.62072],
  miles: null, note: '', needsReview: false,
}, 'owner@example.com')
check('a rest day asks for no directions', directionsCalls === 0, `${directionsCalls} call(s)`)
check('and carries no distance', (await dayOn(rest.date)).miles === null)

// ── A day can change from riding to resting, and back ─────────────────────
// The editor had no way to do this at all: it read each day's kind and saved
// the same one straight back, so a rest day could never move. What matters on
// the way in is that the destination survives — a rest day is still somewhere,
// and it is the town he was riding to.
const swap = PLAN.find((d) => d.kind === 'ride' && d.date > rest.date && d.to && d.fromCoords)
await saveDay(
  { date: swap.date, kind: 'rest', from: null, fromCoords: null,
    to: swap.to, toCoords: swap.toCoords, miles: null, note: '', needsReview: false },
  'john@example.com',
)
const rested = await dayOn(swap.date)
check('a riding day can be made a rest day', rested.kind === 'rest', rested.kind)
check('and keeps the place it was heading for', rested.to === swap.to, String(rested.to))
check('while losing the start it no longer has', rested.from === null, String(rested.from))
check('and the distance, which was about a different day', rested.miles === null, String(rested.miles))

// And back the other way, taking its start from wherever the day before ends.
await saveDay(
  { date: swap.date, kind: 'ride', from: swap.from, fromCoords: swap.fromCoords,
    to: swap.to, toCoords: swap.toCoords, miles: null, note: '', needsReview: false },
  'john@example.com',
)
const riding = await dayOn(swap.date)
check('and back to a riding day', riding.kind === 'ride', riding.kind)
check('with a start again', riding.from === swap.from, String(riding.from))
check('and a distance worked out for it', riding.miles !== null, `${riding.miles} mi`)

// The plan is still the plan. This is the one that would go unnoticed.
const planStill = JSON.parse(readFileSync('src/data/itinerary.json', 'utf8'))
  .days.find((d) => d.date === swap.date)
check('and the plan on disk still calls it a riding day', planStill.kind === 'ride', planStill.kind)

// ── The drawn line fits where it has to go ─────────────────────────────────
const long = (await dayOn(target.date)).routeCoords
check('the full line is kept in the database', long.length === 500)
const emailLine = lineForEmail(long)
const mapLine = lineForMap(long)
check('the email line fits a URL', emailLine.length <= 60, `${emailLine.length} points`)
check('and still bends', emailLine.length > 5, `${emailLine.length} points`)
check('the map line stays inside the wire budget', mapLine.length <= 120, `${mapLine.length} points`)
check('and is the more detailed of the two', mapLine.length >= emailLine.length)

// ── An unreachable database is the plan, not an empty map ──────────────────
globalThis.__pg = () => { throw new Error('no database') }
const fallback = await loadRoute()
check('a broken database falls back to the plan', fallback.length === PLAN.length)
check('rather than to nothing', fallback.find((d) => d.date === target.date)?.to === before.to)

// ── The place lookup asks for types that exist ─────────────────────────────
// The editor shipped asking Mapbox for "village" and "town". Neither is a
// Mapbox type, so every search returned 422, the suggestion list was always
// empty, and the one thing the page exists to do could not be done. Nothing
// reported it: a failed lookup and a town that does not exist looked the same.
const geo = await esbuild.build({
  entryPoints: ['src/lib/geocode.ts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
})
writeFileSync(join(dir, 'geocode.mjs'), geo.outputFiles[0].text)
const { DESTINATION_TYPES, MAPBOX_TYPES, searchPlaces, GeocodeError } =
  await import(pathToFileURL(resolve(join(dir, 'geocode.mjs'))).href)

const unknown = DESTINATION_TYPES.filter((t) => !MAPBOX_TYPES.includes(t))
check('every geocoding type is one Mapbox knows', unknown.length === 0,
  unknown.length ? unknown.join(', ') : DESTINATION_TYPES.join(', '))

// A lookup that fails must say so rather than come back empty-handed, or the
// page tells him the town does not exist.
globalThis.fetch = async () => new Response('{"message":"nope"}', { status: 422 })
let raised = null
await searchPlaces('Saint-Marcellin', null, 'pk.test').catch((e) => { raised = e })
check('a failed lookup throws rather than returning nothing', raised instanceof GeocodeError,
  raised?.message)

globalThis.fetch = async () => new Response(JSON.stringify({
  features: [{ text: 'Saint-Marcellin', place_name: 'Saint-Marcellin, Isère, France', center: [5.32, 45.15] }],
}), { status: 200, headers: { 'content-type': 'application/json' } })
const found = await searchPlaces('Saint-Marcellin', [4.38, 44.62], 'pk.test')
check('a good lookup returns the town and its coordinates',
  found[0]?.name === 'Saint-Marcellin' && found[0]?.coords[0] === 5.32, found[0]?.context)
check('a query too short to mean anything asks nothing',
  (await searchPlaces('S', null, 'pk.test')).length === 0)

console.log(failures === 0 ? '\nAll route checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
