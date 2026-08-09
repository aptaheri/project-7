/**
 * generate-backfill.mjs
 *
 * Reconstructs the riding John did before the tracker existed, as a migration.
 *
 *   node scripts/generate-backfill.mjs
 *
 * THIS IS NOT MEASURED DATA. Every point is inferred from the planned route,
 * the itinerary, and what he wrote on Instagram. It is stored with
 * source='backfill' so it can be told apart from real fixes at every level:
 * drawn dashed on the map, and excluded from anything that claims precision.
 *
 * Evidence used, from his posts:
 *   Aug 1  Day 1, Lisbon to Nazaré. "a lot went wrong"; dinner at a Pizza Hut
 *          in Caldas da Rainha, last 20 miles ridden in the dark.
 *   Aug 2  Rest day in Nazaré ("the rest day here today").
 *   Aug 3  Day 3, Nazaré to Mira. "Rain and another big equipment issue".
 *   Aug 4  Mira to Porto.
 *   Aug 5  Wednesday. Crashed ~12 miles out of Porto, stitches to the right
 *          hand, then rode on "as far as Ponte de Lima that day".
 *   Aug 6-8 Recovering in Ponte de Lima. No riding, so nothing is generated.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Distance between generated points. Fine enough to trace the roads. */
const SPACING_M = 250

const DEVICE = 'backfill/john/reconstructed'

/** Portugal runs UTC+1 in August, and the times below are local. */
const UTC_OFFSET_HOURS = 1

const EARTH_RADIUS_M = 6371000

function metres(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function routeCoords(file) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  const line = data.features.find((f) => f.geometry.type === 'LineString')
  return line.geometry.coordinates
}

function nearestIndex(coords, target) {
  let best = 0
  let bestDistance = Infinity
  coords.forEach((c, i) => {
    const d = metres(c, target)
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  })
  return best
}

/** Walks a path, emitting a point every SPACING_M along it. */
function sample(coords) {
  const out = [coords[0]]
  let carried = 0
  for (let i = 1; i < coords.length; i += 1) {
    carried += metres(coords[i - 1], coords[i])
    if (carried >= SPACING_M) {
      out.push(coords[i])
      carried = 0
    }
  }
  const last = coords[coords.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

function pathLength(coords) {
  let total = 0
  for (let i = 1; i < coords.length; i += 1) total += metres(coords[i - 1], coords[i])
  return total
}

/** Spreads timestamps across the riding window, in step with distance covered. */
function stamp(coords, date, startHour, endHour) {
  const start = Date.parse(`${date}T${String(startHour).padStart(2, '0')}:00:00Z`) -
    UTC_OFFSET_HOURS * 3600_000
  const span = (endHour - startHour) * 3600_000
  const total = pathLength(coords) || 1

  let covered = 0
  return coords.map((c, i) => {
    if (i > 0) covered += metres(coords[i - 1], c)
    return { lon: c[0], lat: c[1], at: new Date(start + (covered / total) * span) }
  })
}

// ── Build each day's path ────────────────────────────────────────────────────

const planned = routeCoords('public/geojson/stage1-ultra.geojson')

const WAYPOINTS = {
  guincho: [-9.4725, 38.7325],
  nazare: [-9.0678, 39.6016],
  mira: [-8.7381, 40.4288],
  porto: [-8.6291, 41.1579],
}

const idx = Object.fromEntries(
  Object.entries(WAYPOINTS).map(([k, v]) => [k, nearestIndex(planned, v)]),
)

// Porto to Ponte de Lima is not on the planned route — he diverted after the
// crash — so it comes from a cycling directions lookup instead of a slice.
const divertFile = path.join(ROOT, 'scripts', 'data', 'porto-ponte-de-lima.json')
if (!fs.existsSync(divertFile)) {
  console.error(`Missing ${path.relative(ROOT, divertFile)}.`)
  console.error('Fetch it from the Mapbox cycling directions API first.')
  process.exit(1)
}
const divert = JSON.parse(fs.readFileSync(divertFile, 'utf8')).routes[0].geometry.coordinates

const days = [
  {
    date: '2026-08-01',
    label: 'Lisbon to Nazaré',
    coords: planned.slice(idx.guincho, idx.nazare + 1),
    // Finished after dark, by his own account.
    from: 9,
    to: 23,
  },
  {
    date: '2026-08-03',
    label: 'Nazaré to Mira',
    coords: planned.slice(idx.nazare, idx.mira + 1),
    from: 8,
    to: 17,
  },
  {
    date: '2026-08-04',
    label: 'Mira to Porto',
    coords: planned.slice(idx.mira, idx.porto + 1),
    from: 8,
    to: 17,
  },
  {
    date: '2026-08-05',
    label: 'Porto to Ponte de Lima (crash, stitches, continued)',
    coords: divert,
    from: 8,
    to: 19,
  },
]

const rows = []
for (const day of days) {
  const sampled = sample(day.coords)
  const stamped = stamp(sampled, day.date, day.from, day.to)
  const miles = (pathLength(sampled) / 1609.34).toFixed(1)
  console.log(
    `${day.date}  ${day.label.padEnd(52)} ${String(stamped.length).padStart(5)} pts  ${miles.padStart(6)} mi`,
  )
  rows.push(...stamped)
}

// ── Emit the migration ───────────────────────────────────────────────────────

const values = rows
  .map(
    (r) =>
      `  ('${DEVICE}', '${r.at.toISOString()}', ${r.lat.toFixed(6)}, ${r.lon.toFixed(6)}, 'backfill', '{"backfill":true}'::jsonb)`,
  )
  .join(',\n')

const sql = `-- Reconstructed riding from Lisbon to Ponte de Lima, 1-5 August 2026.
--
-- NOT MEASURED DATA. The tracker did not exist yet. Geometry comes from the
-- planned route, except 5 August which is a cycling directions lookup because
-- he diverted 21 km off-plan to Ponte de Lima after crashing outside Porto.
-- Timestamps are spread across plausible riding hours, not observed.
--
-- Stored with source='backfill' so it stays distinguishable from real fixes.
-- Generated by scripts/generate-backfill.mjs; edit that, not this.
--
-- Rest days (2, 6, 7, 8 August) produce nothing: he was not riding.

delete from locations where device = '${DEVICE}';

insert into locations (device, tst, lat, lon, source, raw) values
${values};
`

const out = path.join(
  ROOT,
  'netlify',
  'database',
  'migrations',
  '0005_backfill_lisbon_to_ponte_de_lima.sql',
)
fs.writeFileSync(out, sql)
console.log(`\n${rows.length} points -> ${path.relative(ROOT, out)} (${(sql.length / 1024).toFixed(0)} KB)`)
