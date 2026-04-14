import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './MapView.scss'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const STAGE_URLS = [
  '/geojson/stage1-map.geojson',
  '/geojson/stage2-map.geojson',
  '/geojson/stage3-map.geojson',
  '/geojson/stage4-map.geojson',
  '/geojson/stage5-map.geojson',
  '/geojson/stage6-map.geojson',
  '/geojson/stage7-map.geojson',
]

const DETAIL_URLS = [
  '/geojson/stage1-detail.geojson',
  '/geojson/stage2-detail.geojson',
  '/geojson/stage3-detail.geojson',
  '/geojson/stage4-detail.geojson',
  '/geojson/stage5-detail.geojson',
  '/geojson/stage6-detail.geojson',
  '/geojson/stage7-detail.geojson',
]

const ULTRA_URLS = [
  '/geojson/stage1-ultra.geojson',
  '/geojson/stage2-ultra.geojson',
  '/geojson/stage3-ultra.geojson',
  '/geojson/stage4-ultra.geojson',
  '/geojson/stage5-ultra.geojson',
  '/geojson/stage6-ultra.geojson',
  '/geojson/stage7-ultra.geojson',
]

// Zoom thresholds for LOD swaps
const DETAIL_ZOOM = 6
const ULTRA_ZOOM  = 8

const PIN_LAYERS = ['waypoints-border', 'waypoints']

type Quality = 'map' | 'detail' | 'ultra' | 'ultra-loading'

interface StageBounds { w: number; e: number; s: number; n: number }

function computeStageBounds(fc: GeoJSON.FeatureCollection): StageBounds | null {
  const coords = fc.features
    .filter((f) => f.geometry.type === 'LineString')
    .flatMap((f) => (f.geometry as GeoJSON.LineString).coordinates) as [number, number][]
  if (!coords.length) return null
  return coords.reduce(
    (b, [lng, lat]) => ({
      w: Math.min(b.w, lng), e: Math.max(b.e, lng),
      s: Math.min(b.s, lat), n: Math.max(b.n, lat),
    }),
    { w: coords[0][0], e: coords[0][0], s: coords[0][1], n: coords[0][1] },
  )
}

function viewportIntersects(vp: mapboxgl.LngLatBounds, b: StageBounds): boolean {
  return !(vp.getEast() < b.w || vp.getWest() > b.e || vp.getNorth() < b.s || vp.getSouth() > b.n)
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef       = useRef<mapboxgl.Map | null>(null)
  const [mapReady, setMapReady]     = useState(false)
  const [showLabels, setShowLabels] = useState(false)
  const [showRoads,  setShowRoads]  = useState(false)
  const [showPins,   setShowPins]   = useState(false)
  const labelLayersRef  = useRef<string[]>([])
  const roadLayersRef   = useRef<string[]>([])

  // Per-stage LOD state
  const stageDataRef    = useRef<GeoJSON.FeatureCollection[]>([])
  const stageQualityRef = useRef<Quality[]>([])
  const stageBoundsRef  = useRef<Array<StageBounds | null>>([])
  const detailLoadedRef = useRef(false)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      projection: 'globe',
      center: [20, 41],
      zoom: 2.5,
    })

    mapRef.current = map

    // Combines all per-stage data into one FeatureCollection and updates the source
    function updateSource() {
      ;(map.getSource('route') as mapboxgl.GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: stageDataRef.current.flatMap((fc) => fc.features),
      })
    }

    map.on('load', async () => {
      // --- Initial load: slim map-quality files ---
      const stages = await Promise.all(
        STAGE_URLS.map((url) => fetch(url).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>))
      )

      stageDataRef.current    = stages
      stageQualityRef.current = stages.map(() => 'map' as Quality)
      stageBoundsRef.current  = stages.map(computeStageBounds)

      const allStages: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: stages.flatMap((s) => s.features),
      }

      // Atmospheric fog
      map.setFog({
        color: 'rgb(20, 20, 30)',
        'high-color': 'rgb(10, 10, 20)',
        'horizon-blend': 0.08,
        'space-color': 'rgb(5, 5, 15)',
        'star-intensity': 0.4,
      })

      map.addSource('route', { type: 'geojson', data: allStages })

      map.addLayer({
        id: 'route-glow', type: 'line', source: 'route',
        filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#4285f4', 'line-width': 14, 'line-opacity': 0.15, 'line-blur': 4 },
      })
      // Dark shadow so the route is visible on white surfaces (Antarctica snow)
      map.addLayer({
        id: 'route-shadow', type: 'line', source: 'route',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#000000', 'line-width': 10, 'line-opacity': 0.25 },
      })
      map.addLayer({
        id: 'route-casing', type: 'line', source: 'route',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4285f4', 'line-width': 4, 'line-opacity': 1 },
      })
      map.addLayer({
        id: 'waypoints-border', type: 'circle', source: 'route',
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-opacity': 0.9 },
      })
      map.addLayer({
        id: 'waypoints', type: 'circle', source: 'route',
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 4, 'circle-color': '#4285f4', 'circle-opacity': 1 },
      })

      // Fit camera — exclude stage7 (Antarctica, lat ~-83) which breaks fitBounds on globe
      const fittableFeatures = stages.slice(0, 6).flatMap((s) => s.features)
      const lines = fittableFeatures.filter((f) => f.geometry.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString>[]
      if (lines.length) {
        const coords = lines.flatMap((f) => f.geometry.coordinates) as [number, number][]
        const bounds = coords.reduce(
          (b, c) => b.extend(c),
          new mapboxgl.LngLatBounds(coords[0], coords[0]),
        )
        map.fitBounds(bounds, { padding: 60, duration: 1200 })
      }

      // Tooltip
      const tooltip = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, className: 'waypoint-tooltip' })
      map.on('mouseenter', 'waypoints', (e) => {
        map.getCanvas().style.cursor = 'pointer'
        const f = e.features?.[0]
        if (!f) return
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number]
        tooltip.setLngLat(coords).setHTML(f.properties?.name as string).addTo(map)
      })
      map.on('mouseleave', 'waypoints', () => {
        map.getCanvas().style.cursor = ''
        tooltip.remove()
      })

      // Discover base style layers — exclude our own route layers
      const ourLayers = new Set(['route-glow', 'route-shadow', 'route-casing', 'route-line', 'waypoints-border', 'waypoints'])
      const baseLayers = map.getStyle().layers.filter((l) => !ourLayers.has(l.id))

      labelLayersRef.current = baseLayers.filter((l) => l.type === 'symbol').map((l) => l.id)
      roadLayersRef.current  = baseLayers.filter((l) => l.type === 'line').map((l) => l.id)

      // Apply initial visibility: labels, roads, and pins all hidden
      ;[...labelLayersRef.current, ...roadLayersRef.current, ...PIN_LAYERS].forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none')
      })

      setMapReady(true)

      // --- Progressive LOD on zoom ---
      map.on('zoomend', async () => {
        const zoom = map.getZoom()

        // Level 1 → Level 2: swap all stages to detail quality
        if (!detailLoadedRef.current && zoom >= DETAIL_ZOOM) {
          detailLoadedRef.current = true

          const detailStages = await Promise.all(
            DETAIL_URLS.map((url) => fetch(url).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>))
          )

          // Only overwrite stages not already being upgraded to ultra
          detailStages.forEach((fc, i) => {
            if (stageQualityRef.current[i] !== 'ultra' && stageQualityRef.current[i] !== 'ultra-loading') {
              stageDataRef.current[i]    = fc
              stageQualityRef.current[i] = 'detail'
            }
          })
          updateSource()
        }

        // Level 2 → Level 3: swap visible stages to ultra quality
        if (zoom >= ULTRA_ZOOM) {
          const vp = map.getBounds()
          ULTRA_URLS.forEach((url, i) => {
            const q = stageQualityRef.current[i]
            if (q === 'ultra' || q === 'ultra-loading') return
            const b = stageBoundsRef.current[i]
            if (!b || !viewportIntersects(vp, b)) return

            stageQualityRef.current[i] = 'ultra-loading'
            fetch(url)
              .then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
              .then((fc) => {
                if (!mapRef.current) return
                stageDataRef.current[i]    = fc
                stageQualityRef.current[i] = 'ultra'
                updateSource()
              })
          })
        }
      })
    })

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  // Toggle label layers
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visibility = showLabels ? 'visible' : 'none'
    labelLayersRef.current.forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    })
  }, [showLabels, mapReady])

  // Toggle road layers
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visibility = showRoads ? 'visible' : 'none'
    roadLayersRef.current.forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    })
  }, [showRoads, mapReady])

  // Toggle pin layers
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const visibility = showPins ? 'visible' : 'none'
    PIN_LAYERS.forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
    })
  }, [showPins, mapReady])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} className="map-container" />
      <div className="map-controls">
        <button className={`map-control-btn${showLabels ? ' active' : ''}`} onClick={() => setShowLabels((v) => !v)}>
          <span className="map-control-dot" />
          Labels
        </button>
        <button className={`map-control-btn${showRoads ? ' active' : ''}`} onClick={() => setShowRoads((v) => !v)}>
          <span className="map-control-dot" />
          Roads
        </button>
        <button className={`map-control-btn${showPins ? ' active' : ''}`} onClick={() => setShowPins((v) => !v)}>
          <span className="map-control-dot" />
          Pins
        </button>
      </div>
    </div>
  )
}
