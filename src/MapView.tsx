import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import stage1Raw from './data/stage1-directions.geojson?raw'
import stage2Raw from './data/stage2-directions.geojson?raw'
import stage3Raw from './data/stage3-directions.geojson?raw'
import stage4Raw from './data/stage4-directions.geojson?raw'
import stage5Raw from './data/stage5-directions.geojson?raw'
import stage6Raw from './data/stage6-directions.geojson?raw'
import './MapView.scss'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const stage1 = JSON.parse(stage1Raw) as GeoJSON.FeatureCollection
const stage2 = JSON.parse(stage2Raw) as GeoJSON.FeatureCollection
const stage3 = JSON.parse(stage3Raw) as GeoJSON.FeatureCollection
const stage4 = JSON.parse(stage4Raw) as GeoJSON.FeatureCollection
const stage5 = JSON.parse(stage5Raw) as GeoJSON.FeatureCollection
const stage6 = JSON.parse(stage6Raw) as GeoJSON.FeatureCollection

const allStages: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [...stage1.features, ...stage2.features, ...stage3.features, ...stage4.features, ...stage5.features, ...stage6.features],
}

const PIN_LAYERS = ['waypoints-border', 'waypoints']

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef       = useRef<mapboxgl.Map | null>(null)
  const [mapReady, setMapReady]     = useState(false)
  const [showLabels, setShowLabels] = useState(false)
  const [showRoads,  setShowRoads]  = useState(false)
  const [showPins,   setShowPins]   = useState(false)
  const labelLayersRef = useRef<string[]>([])
  const roadLayersRef  = useRef<string[]>([])

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

    map.on('load', () => {
      map.addSource('route', { type: 'geojson', data: allStages })

      map.addLayer({
        id: 'route-glow', type: 'line', source: 'route',
        filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#4285f4', 'line-width': 14, 'line-opacity': 0.15, 'line-blur': 4 },
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

      // Fit camera
      const lines = allStages.features.filter((f) => f.geometry.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString>[]
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
      const ourLayers = new Set(['route-glow', 'route-casing', 'route-line', 'waypoints-border', 'waypoints'])
      const baseLayers = map.getStyle().layers.filter((l) => !ourLayers.has(l.id))

      labelLayersRef.current = baseLayers
        .filter((l) => l.type === 'symbol')
        .map((l) => l.id)

      roadLayersRef.current = baseLayers
        .filter((l) => l.type === 'line')
        .map((l) => l.id)

      // Apply initial visibility: labels, roads, and pins all hidden
      ;[...labelLayersRef.current, ...roadLayersRef.current, ...PIN_LAYERS].forEach((id) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none')
      })

      setMapReady(true)
    })

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  // Toggle label layers (all symbol layers discovered at load time)
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
