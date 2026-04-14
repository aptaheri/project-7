/**
 * Pre-generates slim GeoJSON files for web consumption.
 *
 * Full files have 66k–280k LineString coords — way too large for mobile.
 * This creates four variants per stage:
 *   - *-home.geojson   :    800 pts  (home page animation)
 *   - *-map.geojson    :  4,000 pts  (map view, initial globe zoom)
 *   - *-detail.geojson : 15,000 pts  (map view, loaded at zoom > 6)
 *   - *-ultra.geojson  : 60,000 pts  (map view, loaded per-stage at zoom > 8)
 *
 * Point (waypoint) features are always kept in full.
 */

const fs   = require('fs')
const path = require('path')

const GEOJSON_DIR    = path.join(__dirname, '../public/geojson')
const STAGES         = 7
const HOME_TARGET    = 800
const MAP_TARGET     = 4000
const DETAIL_TARGET  = 15000
const ULTRA_TARGET   = 60000

function sample(coords, target) {
  if (coords.length <= target) return coords
  const step = Math.ceil(coords.length / target)
  const out  = coords.filter((_, i) => i % step === 0)
  // Always include the last point
  const last = coords[coords.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

let totalSaved = 0

for (let i = 1; i <= STAGES; i++) {
  const inPath = path.join(GEOJSON_DIR, `stage${i}-directions.geojson`)
  const fc     = JSON.parse(fs.readFileSync(inPath, 'utf8'))

  const lineFeature = fc.features.find((f) => f.geometry.type === 'LineString')
  const pointFeats  = fc.features.filter((f) => f.geometry.type === 'Point')

  if (!lineFeature) {
    console.warn(`stage${i}: no LineString found, skipping`)
    continue
  }

  const origCount = lineFeature.geometry.coordinates.length

  for (const [suffix, target] of [['home', HOME_TARGET], ['map', MAP_TARGET], ['detail', DETAIL_TARGET], ['ultra', ULTRA_TARGET]]) {
    const slimCoords = sample(lineFeature.geometry.coordinates, target)

    const slimFC = {
      type: 'FeatureCollection',
      features: [
        { ...lineFeature, geometry: { type: 'LineString', coordinates: slimCoords } },
        ...pointFeats,
      ],
    }

    const outPath = path.join(GEOJSON_DIR, `stage${i}-${suffix}.geojson`)
    const json    = JSON.stringify(slimFC)
    fs.writeFileSync(outPath, json)

    const kb = (json.length / 1024).toFixed(1)
    console.log(`stage${i}-${suffix}.geojson  ${slimCoords.length} coords / ${origCount} orig  →  ${kb} KB`)
    totalSaved += json.length
  }
}

console.log(`\nTotal slim output: ${(totalSaved / 1024 / 1024).toFixed(1)} MB`)
