/**
 * fetch-directions.mjs
 *
 * Reads a stage GeoJSON file, calls the Mapbox Directions API
 * (cycling profile) for each batch of up to 10 consecutive waypoints,
 * stitches the results together, and writes a -directions.geojson file.
 *
 * Usage:
 *   node scripts/fetch-directions.mjs src/data/stage2.geojson
 *
 * Requires VITE_MAPBOX_TOKEN in .env at the project root.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── Parse input argument ───────────────────────────────────────────────────
const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/fetch-directions.mjs src/data/stageN.geojson')
  process.exit(1)
}

const srcPath = path.resolve(ROOT, input)
if (!fs.existsSync(srcPath)) {
  console.error(`File not found: ${srcPath}`)
  process.exit(1)
}

// Derive output path: stage2.geojson → stage2-directions.geojson
const ext = path.extname(srcPath)
const outPath = srcPath.replace(new RegExp(`${ext}$`), `-directions${ext}`)

// ── Load token from .env ───────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(ROOT, '.env')
  if (!fs.existsSync(envPath)) throw new Error('.env file not found at project root')
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    process.env[key] = value
  }
}

loadEnv()

const TOKEN = process.env.VITE_MAPBOX_TOKEN
if (!TOKEN) throw new Error('VITE_MAPBOX_TOKEN not found in .env')

// ── Load source GeoJSON ────────────────────────────────────────────────────
const geojson = JSON.parse(fs.readFileSync(srcPath, 'utf-8'))

const points = geojson.features
  .filter((f) => f.geometry.type === 'Point')
  .sort((a, b) => a.properties.order - b.properties.order)

console.log(`Input:  ${srcPath}`)
console.log(`Output: ${outPath}`)
console.log(`Loaded ${points.length} waypoints`)

// ── Batch into groups of 10, sharing endpoints ─────────────────────────────
const BATCH_SIZE = 5

function chunk(arr, size) {
  const batches = []
  let i = 0
  while (i < arr.length) {
    batches.push(arr.slice(i, i + size))
    i += size - 1
  }
  return batches
}

const batches = chunk(points, BATCH_SIZE).filter((b) => b.length >= 2)
console.log(`Split into ${batches.length} batch(es) of ≤${BATCH_SIZE} waypoints\n`)

// ── Call Directions API ────────────────────────────────────────────────────
async function fetchDirections(waypoints) {
  const coords = waypoints.map((f) => f.geometry.coordinates.join(',')).join(';')
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/cycling/${coords}` +
    `?access_token=${TOKEN}&geometries=geojson&overview=full&steps=false&exclude=ferry`

  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Directions API error ${res.status}: ${body}`)
  }
  const data = await res.json()
  if (!data.routes || data.routes.length === 0) {
    throw new Error(`No route returned for batch starting at waypoint order=${waypoints[0].properties.order}`)
  }
  return data.routes[0].geometry.coordinates
}

// ── Stitch batches ─────────────────────────────────────────────────────────
const allCoords = []

for (let i = 0; i < batches.length; i++) {
  const batch = batches[i]
  const start = batch[0].properties.order
  const end = batch[batch.length - 1].properties.order
  console.log(`Fetching batch ${i + 1}/${batches.length}: waypoints ${start}–${end}...`)

  const coords = await fetchDirections(batch)
  allCoords.push(...(i === 0 ? coords : coords.slice(1)))

  if (i < batches.length - 1) await new Promise((r) => setTimeout(r, 300))
}

console.log(`\nStitched route has ${allCoords.length} coordinates`)

// ── Write output ───────────────────────────────────────────────────────────
const lineProps = geojson.features.find((f) => f.geometry.type === 'LineString')?.properties ?? {}

const output = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: allCoords },
      properties: { ...lineProps, profile: 'cycling' },
    },
    ...points,
  ],
}

fs.writeFileSync(outPath, JSON.stringify(output, null, 2))
console.log(`Wrote ${outPath}`)
