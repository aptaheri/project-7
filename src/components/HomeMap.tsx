import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

// Only stages 1–3 are used for the home animation; they loop continuously.
// Uses pre-slimmed *-home.geojson files (~25 KB each vs ~10+ MB originals).
const ANIM_STAGE_URLS = [
  '/geojson/stage1-home.geojson',
  '/geojson/stage2-home.geojson',
  '/geojson/stage3-home.geojson',
]

function extractCoords(fc: GeoJSON.FeatureCollection): [number, number][] {
  const line = fc.features.find((f) => f.geometry.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString> | undefined
  return (line?.geometry.coordinates ?? []) as [number, number][]
}

const emptyLine: GeoJSON.Feature = {
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [] },
  properties: {},
}

const START_ZOOM       = 2.8
const FOLLOW_ZOOM      = 5.5
const ZOOM_IN_MS       = 3_500
const TRACE_MS         = 90_000
const TRANSITION_MS    = 3_500
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
      center: [-9.472264, 38.732407], // start of stage 1
      zoom: START_ZOOM,
      interactive: false,
      attributionControl: false,
    })

    mapRef.current = map

    map.on('load', async () => {
      if (destroyed) return

      // Fetch only the 3 animation stages in parallel
      const featureCollections = await Promise.all(
        ANIM_STAGE_URLS.map((url) => fetch(url).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>))
      )

      if (destroyed) return

      const stageCoords = featureCollections.map((fc) => extractCoords(fc))

      // Ghost lines — all 3 stages, static dim display
      const ghostData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: featureCollections.map((fc) => fc.features.find((f) => f.geometry.type === 'LineString')!),
      }

      // Set initial camera to start of stage 1
      map.jumpTo({ center: stageCoords[0][0], zoom: START_ZOOM })

      map.setFog({
        color: 'rgb(20, 20, 30)',
        'high-color': 'rgb(10, 10, 20)',
        'horizon-blend': 0.08,
        'space-color': 'rgb(5, 5, 15)',
        'star-intensity': 0.4,
      })

      map.addSource('route-ghost', { type: 'geojson', data: ghostData })
      map.addLayer({
        id: 'ghost-line', type: 'line', source: 'route-ghost',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.15 },
      })

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

        ;(map.getSource('route-anim') as mapboxgl.GeoJSONSource).setData(emptyLine)

        let startTime: number | null = null
        let camLng = sampled[0][0]
        let camLat = sampled[0][1]

        function frame(ts: number) {
          if (destroyed) return
          if (!startTime) startTime = ts

          const elapsed = ts - startTime
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
            markComplete(stageIdx)
            ;(map.getSource('route-anim') as mapboxgl.GeoJSONSource).setData(emptyLine)

            const nextIdx = (stageIdx + 1) % stageCoords.length

            // On loop restart (nextIdx === 0): clear completed stages and reset camera
            if (nextIdx === 0) {
              completedFeatures.length = 0
              ;(map.getSource('route-done') as mapboxgl.GeoJSONSource).setData({
                type: 'FeatureCollection',
                features: [],
              })
            }

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
