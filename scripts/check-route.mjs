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
  create table destination_facts (
    destination text primary key, fact text, model text not null,
    created_at timestamptz not null default now(), now_line text, distance_line text
  );
  create table route_geometry (
    date date primary key,
    from_lon double precision not null, from_lat double precision not null,
    to_lon double precision not null, to_lat double precision not null,
    coords jsonb not null,
    version int not null default 1,
    computed_at timestamptz not null default now()
  );
`)
globalThis.__pg = tagged

// Mapbox directions, stubbed. Real ones cost a call and a second and would make
// this test depend on the weather in Ardèche.
let directionsCalls = 0
// The last URL asked for, so the parameters can be checked and not just the
// answer — "no ferries" is a thing said in the request, not seen in the reply.
let lastDirectionsUrl = ''
// Overridable, so an implausible road can be handed back on purpose.
let directionsKm = null
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.mapbox.com/directions')) throw new Error(`unexpected fetch: ${url}`)
  directionsCalls++
  lastDirectionsUrl = String(url)
  // A road that bends, not a ruler: a straight line simplifies to two points
  // and would let a broken thinner pass.
  const coords = Array.from({ length: 500 }, (_, i) => [
    3.3 + i * 0.002,
    44.4 + i * 0.0004 + Math.sin(i / 7) * 0.01,
  ])
  return new Response(
    JSON.stringify({
      code: 'Ok',
      routes: [{ distance: (directionsKm ?? 114) * 1000, geometry: { coordinates: coords } }],
    }),
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
const { loadRoute, saveDay, rechainNextDay, shiftFrom, upcomingRoute, fillMissingRoads, englishNames, cyclingRoute, lineForEmail, lineForMap, PLAN } =
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
// A riding day whose next day is also a riding day, because the rechain
// assertions below need one to rechain onto. Stated rather than assumed: this
// used to take the first ride day with coordinates and got away with it only
// because day one had none. The moment Lisbon was given a position the target
// became day one, whose next day is a rest, and rechainNextDay correctly did
// nothing — three checks failed for a reason that had nothing to do with them.
const target = PLAN.find((d, i) => {
  const next = PLAN[i + 1]
  return (
    d.kind === 'ride' && d.to && d.fromCoords && d.toCoords &&
    next && next.kind === 'ride' && next.to
  )
})
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
check('and rests where the day before left him', rested.to === swap.to, String(rested.to))
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

// ── Losing a day moves every day after it ─────────────────────────────────
// He is behind more often than not, and the only way to say so used to be to
// retype every remaining day — so it never got said, and the tracker went on
// believing he was resting somewhere he had not reached.
const callsBeforeShift = directionsCalls
const window0 = (await loadRoute()).filter((d) => d.date >= '2026-09-04' && d.date <= '2026-09-10')
const wasOn = new Map(window0.map((d) => [d.date, { kind: d.kind, to: d.to, miles: d.miles }]))

const moved = await shiftFrom('2026-09-05', '2026-09-10', 'john@example.com')
check('a shift writes every day in the window', moved === 6, `${moved} day(s)`)
check('and asks Mapbox for nothing', directionsCalls === callsBeforeShift,
  `${directionsCalls - callsBeforeShift} call(s)`)

const after = await loadRoute()
const on = (date) => after.find((d) => d.date === date)

// The 5th was the rest day; it now holds what the 4th held — the ride in.
check('each day takes what the day before it held',
  on('2026-09-05').to === wasOn.get('2026-09-04').to &&
  on('2026-09-05').kind === wasOn.get('2026-09-04').kind,
  `${on('2026-09-05').kind} to ${on('2026-09-05').to}`)
check('so the rest day lands a day later',
  on('2026-09-06').kind === 'rest' && on('2026-09-06').to === wasOn.get('2026-09-05').to,
  `${on('2026-09-06').kind} at ${on('2026-09-06').to}`)
check('and its distance travels with it',
  on('2026-09-07').miles === wasOn.get('2026-09-06').miles,
  `${on('2026-09-07').miles} mi`)

// The day before the one he named is his own business — he corrects that with
// "I stopped somewhere else", and a shift must not quietly rewrite it.
check('the day before the shift is untouched',
  on('2026-09-04').to === wasOn.get('2026-09-04').to, String(on('2026-09-04').to))
// And nothing past the window, which is the whole bargain of shifting only what
// he can see.
check('and nothing past the window moves',
  on('2026-09-11').to === PLAN.find((d) => d.date === '2026-09-11').to,
  String(on('2026-09-11').to))

check('every shifted day is marked as changed',
  ['2026-09-05', '2026-09-06', '2026-09-07'].every((d) => on(d).edited === true))

// Nothing to take a schedule from is a refusal, not a silent no-op on day one.
const nothingBefore = await shiftFrom(PLAN[0].date, PLAN[3].date, 'john@example.com')
check('a shift from the first day of the trip does nothing', nothingBefore === 0, `${nothingBefore}`)

const planOnDisk = JSON.parse(readFileSync('src/data/itinerary.json', 'utf8')).days
const planAfterShift = planOnDisk.find((d) => d.date === '2026-09-06')
check('the plan on disk still rests on the 5th',
  planOnDisk.find((d) => d.date === '2026-09-05').kind === 'rest')
check('and the plan on disk is still the plan', planAfterShift.kind === 'ride', planAfterShift.kind)

// ── The drawn line fits where it has to go ─────────────────────────────────
const long = (await dayOn(target.date)).routeCoords
check('the full line is kept in the database', long.length === 500)
const emailLine = lineForEmail(long)
const mapLine = lineForMap(long)
check('the email line fits a URL', emailLine.length <= 60, `${emailLine.length} points`)
check('and still bends', emailLine.length > 5, `${emailLine.length} points`)
check('the map line stays inside the wire budget', mapLine.length <= 120, `${mapLine.length} points`)
check('and is the more detailed of the two', mapLine.length >= emailLine.length)

await pg.query('delete from route_days')
await pg.query('delete from route_geometry')

// ── Changing a day's kind moves the next day's start ──────────────────────
// Taking a day off changes where he ends up, so the day after cannot still set
// out from the town he was going to reach — and its road has to be fetched
// again, because it now runs from somewhere else.
{
  const i = PLAN.findIndex((d, n) =>
    d.kind === 'ride' && d.to && d.fromCoords && d.toCoords &&
    PLAN[n + 1]?.kind === 'ride' && PLAN[n + 1]?.to)
  const day = PLAN[i]
  const following = PLAN[i + 1]
  await pg.query('delete from route_days')

  // He takes the day off: the day now ends where the one before it did.
  const standing = PLAN[i - 1]?.to ?? day.from
  await saveDay(
    { date: day.date, kind: 'rest', from: null, fromCoords: null,
      to: standing, toCoords: PLAN[i - 1]?.toCoords ?? day.fromCoords,
      miles: null, note: '', needsReview: false },
    'john@example.com',
  )
  await rechainNextDay(day.date, 'john@example.com')

  const after = (await loadRoute()).find((d) => d.date === following.date)
  check('the day after a new rest day starts where he actually is',
    after.from === standing, `${following.from} -> ${after.from}`)
  check('and its road is fetched again from there',
    Array.isArray(after.routeCoords) && after.routeCoords.length > 1,
    `${after.routeCoords?.length} points`)
  await pg.query('delete from route_days')
}

// ── The fortnight ahead ────────────────────────────────────────────────────
// What people actually ask, after "where is he": where will he be. Read from
// the merge, so a reroute entered last night is what they see this morning.
const from0 = PLAN.find((d) => d.kind === 'ride' && d.to && d.fromCoords && d.toCoords)
const ahead = await upcomingRoute(from0.date, 14)
check('the road ahead covers a fortnight', ahead.length >= 14 && ahead.length <= 15, `${ahead.length} days`)
check('starting today', ahead[0].date === from0.date, ahead[0].date)
check('and every day carries somewhere to be', ahead.every((d) => d.to && d.destination))
check('and no line until he edits one', ahead.every((d) => d.line === null))
check('but a start to draw a straight hop from',
  ahead.filter((d) => d.kind === 'ride').every((d) => d.origin !== null))

// A day he has edited was routed when he saved it, so its line is already
// there and nothing needs fetching.
await saveDay(
  { date: from0.date, kind: 'ride', from: from0.from, fromCoords: from0.fromCoords,
    to: 'Rerouted Tonight', toCoords: from0.toCoords, miles: null, note: '', needsReview: false },
  'john@example.com',
)
const afterEdit = await upcomingRoute(from0.date, 14)
check('an edited day shows where he is now going',
  afterEdit[0].to === 'Rerouted Tonight', afterEdit[0].to)
check('and draws the road he was given', Array.isArray(afterEdit[0].line) && afterEdit[0].line.length > 1,
  `${afterEdit[0].line?.length} points`)
// The next few rides get the detail, because they are what people look at and
// there are only ever two or three of them. A hundred and twenty points over a
// mountain pass is a point every kilometre, which cuts the corners off exactly
// the roads worth seeing.
check('a near day keeps its detail', (afterEdit[0].line?.length ?? 0) > 120,
  `${afterEdit[0].line?.length} points`)
check('and still fits a sane ceiling', (afterEdit[0].line?.length ?? 0) <= 700,
  `${afterEdit[0].line?.length} points`)

// A ride well beyond the near window is still thinned to the wire budget: it
// is a thread on a continent, not a road anybody is about to ride.
const laterRide = PLAN.filter((d, i) => d.kind === 'ride' && d.to && d.fromCoords && d.toCoords && i > 0)
  .find((d) => d.date > from0.date)
if (laterRide) {
  await saveDay(
    { date: laterRide.date, kind: 'ride', from: laterRide.from, fromCoords: laterRide.fromCoords,
      to: laterRide.to, toCoords: laterRide.toCoords, miles: null, note: '', needsReview: false },
    'john@example.com',
  )
  const far = (await upcomingRoute(from0.date, 14)).filter((d) => d.kind === 'ride')
  const beyond = far[4]
  if (beyond?.line) {
    check('a day past the near window is thinned hard', beyond.line.length <= 120,
      `${beyond.line.length} points`)
  }
}

// A rest day is somewhere to be, not something to draw.
const resting = afterEdit.find((d) => d.kind === 'rest')
if (resting) check('a rest day has a destination but no line', resting.line === null && Boolean(resting.to))

await pg.query('delete from route_days')
await pg.query('delete from route_geometry')

// ── A day saved without a road gets one later ──────────────────────────────
// saveDay asks Mapbox once, from a phone. Through Georgia two of his replanned
// days had no road, and the map drew the plan's road through Marneuli and
// Rustavi instead — a road he had replanned away from.
check('an unedited day says so', ahead.every((d) => d.edited === false))
const [first, second] = PLAN.filter((d) => d.kind === 'ride' && d.fromCoords && d.toCoords)
  .filter((d) => d.date > from0.date).slice(0, 2)
directionsKm = 5000 // the save-time fetch comes back as nonsense and is discarded
for (const d of [first, second]) {
  await saveDay(
    { date: d.date, kind: 'ride', from: d.from, fromCoords: d.fromCoords,
      to: d.to, toCoords: d.toCoords, miles: null, note: '', needsReview: false },
    'john@example.com',
  )
}
const unrouted = (await upcomingRoute(from0.date, 14)).find((d) => d.date === first.date)
check('a replanned day with no road is marked edited, for a straight hop',
  unrouted.edited === true && unrouted.line === null)

// Lagodekhi to Balakan: a closed border, routed the long way round. Asking
// again gets the same nonsense, which must not be stored.
const stillClosed = await fillMissingRoads(from0.date, second.date)
check('a road that still cannot be routed stays empty',
  stillClosed === 0 && !(await dayOn(first.date)).routeCoords?.length, `${stillClosed} filled`)

directionsKm = null
const callsBeforeFill = directionsCalls
const filled = await fillMissingRoads(from0.date, first.date)
check('filling fetches only the days in the window', filled === 1 && directionsCalls === callsBeforeFill + 1,
  `${filled} filled, ${directionsCalls - callsBeforeFill} calls`)
const nowRouted = await dayOn(first.date)
check('and stores the road it got', nowRouted.routeCoords?.length > 1, `${nowRouted.routeCoords?.length} points`)
check('without claiming anybody edited it', nowRouted.editedBy === 'john@example.com', nowRouted.editedBy)
check('and a day saved with no distance takes the road\'s',
  nowRouted.miles === Math.round(nowRouted.cyclingMiles), `${nowRouted.miles} mi`)

const callsBeforeRepeat = directionsCalls
await fillMissingRoads(from0.date, first.date)
check('a day that already has a road costs nothing', directionsCalls === callsBeforeRepeat,
  `${directionsCalls - callsBeforeRepeat} calls`)

const planAfterFill = JSON.parse(readFileSync('src/data/itinerary.json', 'utf8')).days
check('filling leaves the plan on disk untouched',
  JSON.stringify(planAfterFill.find((d) => d.date === first.date)) === JSON.stringify(PLAN.find((d) => d.date === first.date)))

await pg.query('delete from route_days')

// ── A road is a road, not a boat ───────────────────────────────────────────
// The cycling profile takes ferries by default, and did: Cesarica to Split came
// back as 697 km via Ancona and back across the Adriatic, for a leg that is 140
// km as the crow flies. It drew him riding out into the Aegean too.
check('directions ask for no ferries', lastDirectionsUrl.includes('exclude=ferry'),
  lastDirectionsUrl.slice(lastDirectionsUrl.indexOf('?')))

// And behind that, a length no detour explains is not a detour. The next bad
// answer will not look like the last one.
directionsKm = 700
const absurd = await cyclingRoute([15.0213211, 44.5648438], [16.4435148, 43.5147118])
check('a road three times the straight line is discarded', absurd === null, JSON.stringify(absurd))
directionsKm = 218
const sane = await cyclingRoute([15.0213211, 44.5648438], [16.4435148, 43.5147118])
check('and a plausible one is kept', sane !== null && Math.round(sane.miles) === 135,
  `${sane && Math.round(sane.miles)} mi`)
directionsKm = null

// ── A border Mapbox will not cross ─────────────────────────────────────────
// Lagodekhi to Balakan: fifteen kilometres, which Mapbox routes 470 km round
// because it treats the crossing as closed. Each side routes on its own.
{
  const realFetch = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url) => {
    const pair = String(url).match(/cycling\/([^?]+)\?/)[1]
    asked.push(pair)
    const [a, b] = pair.split(';').map((p) => p.split(',').map(Number))
    const crow = Math.hypot((b[0] - a[0]) * 83, (b[1] - a[1]) * 111)
    // Through the border: round by Red Bridge, about 450 km further, as the
    // real router answers (618 km for Kaspi to Balakan). Either side: a road.
    const through = (a[0] < 46.305) !== (b[0] < 46.305)
    return new Response(JSON.stringify({ code: 'Ok', routes: [{
      distance: (through ? crow + 450 : crow * 1.3) * 1000,
      geometry: { coordinates: [a, b] },
    }] }), { status: 200 })
  }
  const kaspi = [44.42, 41.92]
  const balakan = [46.408936, 41.724606]
  const crossed = await cyclingRoute(kaspi, balakan)
  check('a closed border is ridden through its crossing', crossed !== null && crossed.coords.length === 4,
    crossed ? `${Math.round(crossed.miles)} mi` : 'no road')
  check('as one road from each side', asked.length === 3, asked.join(' | '))

  asked.length = 0
  const elsewhere = await cyclingRoute([15.0213211, 44.5648438], [15.2, 44.6])
  check('a road nowhere near a crossing asks nothing more', elsewhere !== null && asked.length === 1,
    `${asked.length} calls`)
  globalThis.fetch = realFetch
}

// ── Towns saved in their own script are renamed in English ─────────────────
// Before the search asked for English, Vale and Atskuri were saved as ვალე and
// აწყური — the subject line of an email to forty English readers.
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('api.mapbox.com/directions')) return realFetch(url)
    if (!u.includes('language=en')) throw new Error(`not asked in English: ${u}`)
    const query = decodeURIComponent(u.match(/places\/([^.]+)\.json/)[1])
    const features = {
      'ვალე': [{ text: 'Vale', center: [42.873492, 41.609154] }],
      // Two Atskuris; the one in Kakheti is first and is the wrong one.
      'აწყური': [
        { text: 'Atskuri', center: [45.363456, 41.959613] },
        { text: 'Atskuri', center: [43.153467, 41.723619] },
      ],
    }[query] ?? []
    return new Response(JSON.stringify({ features }), { status: 200 })
  }
  const [d1, d2] = PLAN.filter((d) => d.kind === 'ride').slice(10, 12)
  const vale = [42.8735, 41.6091]
  const atskuri = [43.1535, 41.7236]
  await pg.query(`insert into route_days (date, kind, from_place, to_place, from_lon, from_lat, to_lon, to_lat, updated_by)
    values ($1, 'ride', 'Keda', 'ვალე', 42.0, 41.6, $2, $3, 'john@example.com'),
           ($4, 'ride', 'ვალე', 'აწყური', $2, $3, $5, $6, 'john@example.com')`,
    [d1.date, vale[0], vale[1], d2.date, atskuri[0], atskuri[1]])
  await pg.query(`insert into destination_facts (destination, fact, model, now_line)
    values ('აწყური', 'A fortress above the Mtkvari.', 'test', 'A village today.')`)

  const renamed = await englishNames(d1.date, d2.date)
  const one = await dayOn(d1.date)
  const two = await dayOn(d2.date)
  check('a town saved in its own script is renamed in English',
    renamed === 2 && one.to === 'Vale' && two.from === 'Vale' && two.to === 'Atskuri',
    `${one.from} → ${one.to}, ${two.from} → ${two.to}`)
  check('a Latin name is left alone', one.from === 'Keda', one.from)
  const facts = await pg.query(`select destination, fact, now_line from destination_facts order by destination`)
  check('and its warmed lines follow it, so the email is not left empty',
    facts.rows.some((r) => r.destination === 'Atskuri' && r.fact === 'A fortress above the Mtkvari.' && r.now_line === 'A village today.'),
    facts.rows.map((r) => r.destination).join(', '))
  check('a second pass has nothing left to rename', (await englishNames(d1.date, d2.date)) === 0)

  globalThis.fetch = realFetch
  await pg.query('delete from route_days')
  await pg.query('delete from destination_facts')
}

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

let geocodeUrl = ''
globalThis.fetch = async (url) => (
  String(url).includes('mapbox') && (geocodeUrl = String(url)),
  new Response(JSON.stringify({
    features: [{ text: 'Saint-Marcellin', place_name: 'Saint-Marcellin, Isère, France', center: [5.32, 45.15] }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
const found = await searchPlaces('Saint-Marcellin', [4.38, 44.62], 'pk.test')
check('towns are named in English, not their own script', geocodeUrl.includes('language=en'),
  geocodeUrl.slice(geocodeUrl.indexOf('?')))
check('the same town is one suggestion, however many times it is asked for',
  found.length === 1, `${found.length}`)

// ── A town Mapbox does not know, and a namesake it does ─────────────────────
// "Say-Otes" came back from Mapbox as a hamlet in Romania, 2,400 km behind him,
// and Karakalpakiya not at all. OpenStreetMap has the Kazakh village, and the
// nearest answer must come first.
const asked = []
globalThis.fetch = async (url) => {
  url = String(url)
  asked.push(url)
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 })
  if (url.includes('photon')) {
    return ok({ features: [
      { geometry: { coordinates: [56.19, 44.77] }, properties: { name: 'Karakalpakstan', osm_value: 'town', country: 'Uzbekistan' } },
      { geometry: { coordinates: [59.03, 43.79] }, properties: { name: 'Karakalpakia', osm_value: 'industrial', country: 'Uzbekistan' } },
    ] })
  }
  if (url.includes('SayOtes')) {
    return ok({ features: [{ text: 'Saiotes', place_name: 'Saiotes, Mangystau, Kazakhstan', center: [53.53, 44.33] }] })
  }
  return ok({ features: [{ text: 'Oteștii de Sus', place_name: 'Oteștii de Sus, Olt, Romania', center: [24.39, 44.72] }] })
}
const aktau = [51.2, 43.65]
const sayOtes = await searchPlaces('Say-Otes', aktau, 'pk.test')
check('a hyphenated name is also asked for joined up', asked.some((u) => u.includes('SayOtes')))
check('and the nearest answer comes first', sayOtes[0]?.name === 'Saiotes',
  sayOtes.map((p) => `${p.name} ${p.km} km`).join(', '))
check('with how far away each one is', sayOtes.at(-1)?.km > 2000, `${sayOtes.at(-1)?.km} km`)
const kk = await searchPlaces('Karakalpakia', [55.19, 45.32], 'pk.test')
check('OpenStreetMap is asked too, for settlements only',
  kk.some((p) => p.name === 'Karakalpakstan') && !kk.some((p) => p.name === 'Karakalpakia'),
  kk.map((p) => p.name).join(', '))

// One source failing is not the search failing.
globalThis.fetch = async (url) => String(url).includes('photon')
  ? new Response('down', { status: 503 })
  : new Response(JSON.stringify({ features: [{ text: 'Beyneu', place_name: 'Beyneu, Kazakhstan', center: [55.19, 45.32] }] }), { status: 200 })
const halfDown = await searchPlaces('Beyneu', aktau, 'pk.test').catch(() => [])
check('a town is still found when OpenStreetMap is down', halfDown[0]?.name === 'Beyneu')
check('a good lookup returns the town and its coordinates',
  found[0]?.name === 'Saint-Marcellin' && found[0]?.coords[0] === 5.32, found[0]?.context)
check('a query too short to mean anything asks nothing',
  (await searchPlaces('S', null, 'pk.test')).length === 0)

console.log(failures === 0 ? '\nAll route checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
