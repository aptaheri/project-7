import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import stage1Raw from '../data/stage1-directions.geojson?raw'
import stage2Raw from '../data/stage2-directions.geojson?raw'
import stage3Raw from '../data/stage3-directions.geojson?raw'
import stage4Raw from '../data/stage4-directions.geojson?raw'
import stage5Raw from '../data/stage5-directions.geojson?raw'
import stage6Raw from '../data/stage6-directions.geojson?raw'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

// ── Parse & sample each stage independently ──────────────────────────────
function extractCoords(raw: string): [number, number][] {
  const fc = JSON.parse(raw) as GeoJSON.FeatureCollection
  return (
    fc.features.find((f) => f.geometry.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString>
  ).geometry.coordinates as [number, number][]
}

function sample(coords: [number, number][], target = 800): [number, number][] {
  const step = Math.ceil(coords.length / target)
  const s = coords.filter((_, i) => i % step === 0)
  if (s[s.length - 1] !== coords[coords.length - 1]) s.push(coords[coords.length - 1])
  return s
}

const stageCoords = [
  sample(extractCoords(stage1Raw)),
  sample(extractCoords(stage2Raw)),
  sample(extractCoords(stage3Raw)),
  sample(extractCoords(stage4Raw)),
  sample(extractCoords(stage5Raw)),
  sample(extractCoords(stage6Raw)),
]

// Ghost: all stage LineStrings for static dim display
const ghostData: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [stage1Raw, stage2Raw, stage3Raw, stage4Raw, stage5Raw, stage6Raw].map((raw) => {
    const fc = JSON.parse(raw) as GeoJSON.FeatureCollection
    return fc.features.find((f) => f.geometry.type === 'LineString')!
  }),
}

const emptyLine: GeoJSON.Feature = {
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [] },
  properties: {},
}

const START_ZOOM       = 2.8
const FOLLOW_ZOOM      = 5.5
const ZOOM_IN_MS       = 3_500   // initial zoom-in duration
const TRACE_MS         = 90_000  // per stage
const TRANSITION_MS    = 3_500   // flyTo between stages
const CAM_LERP         = 0.015

export default function HomeMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef       = useRef<mapboxgl.Map | null>(null)
  const frameRef     = useRef<number>(0)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    let destroyed = false

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/satellite-v9',
      projection: 'globe',
      center: stageCoords[0][0],
      zoom: START_ZOOM,
      interactive: false,
      attributionControl: false,
    })

    mapRef.current = map

    map.on('load', () => {
      if (destroyed) return

      // Ghost lines — all stages, static
      map.addSource('route-ghost', { type: 'geojson', data: ghostData })
      map.addLayer({
        id: 'ghost-line', type: 'line', source: 'route-ghost',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.15 },
      })

      // Completed stages — accumulates as each stage finishes
      map.addSource('route-done', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'done-casing', type: 'line', source: 'route-done',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: 'done-line', type: 'line', source: 'route-done',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4285f4', 'line-width': 3, 'line-opacity': 1 },
      })

      // Currently-animating line
      map.addSource('route-anim', { type: 'geojson', data: emptyLine })
      map.addLayer({
        id: 'anim-glow', type: 'line', source: 'route-anim',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4285f4', 'line-width': 12, 'line-opacity': 0.2, 'line-blur': 4 },
      })
      map.addLayer({
        id: 'anim-casing', type: 'line', source: 'route-anim',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: 'anim-line', type: 'line', source: 'route-anim',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4285f4', 'line-width': 3, 'line-opacity': 1 },
      })

      const completedFeatures: GeoJSON.Feature[] = []

      function markComplete(stageIdx: number) {
        completedFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: stageCoords[stageIdx] },
          properties: {},
        })
        ;(map.getSource('route-done') as mapboxgl.GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: completedFeatures,
        })
      }

      function runStage(stageIdx: number) {
        if (destroyed) return
        const sampled = stageCoords[stageIdx]

        // Clear animated line for this stage
        ;(map.getSource('route-anim') as mapboxgl.GeoJSONSource).setData(emptyLine)

        let startTime: number | null = null
        let camLng = sampled[0][0]
        let camLat = sampled[0][1]

        function frame(ts: number) {
          if (destroyed) return
          if (!startTime) startTime = ts

          const elapsed = ts - startTime

          // Zoom-in effect (only meaningful on stage 0; later stages arrive pre-zoomed)
          const zoomT = Math.min(elapsed / ZOOM_IN_MS, 1)
          const zoom = stageIdx === 0
            ? START_ZOOM + (FOLLOW_ZOOM - START_ZOOM) * (1 - Math.pow(1 - zoomT, 3))
            : FOLLOW_ZOOM

          const traceT = Math.min(elapsed / TRACE_MS, 1)
          const count = Math.max(2, Math.floor(traceT * sampled.length))
          const visible = sampled.slice(0, count)

          ;(map.getSource('route-anim') as mapboxgl.GeoJSONSource).setData({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: visible },
            properties: {},
          })

          const tip = visible[visible.length - 1]
          camLng += (tip[0] - camLng) * CAM_LERP
          camLat += (tip[1] - camLat) * CAM_LERP
          map.jumpTo({ center: [camLng, camLat], zoom })

          if (traceT < 1) {
            frameRef.current = requestAnimationFrame(frame)
          } else {
            // Stage done — persist it and transition to next
            markComplete(stageIdx)
            ;(map.getSource('route-anim') as mapboxgl.GeoJSONSource).setData(emptyLine)

            const nextIdx = stageIdx + 1
            if (nextIdx < stageCoords.length) {
              const nextStart = stageCoords[nextIdx][0]
              map.flyTo({
                center: nextStart,
                zoom: FOLLOW_ZOOM,
                duration: TRANSITION_MS,
                easing: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
              })
              setTimeout(() => runStage(nextIdx), TRANSITION_MS + 200)
            }
          }
        }

        frameRef.current = requestAnimationFrame(frame)
      }

      runStage(0)
    })

    return () => {
      destroyed = true
      cancelAnimationFrame(frameRef.current)
      map.remove()
      mapRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}
