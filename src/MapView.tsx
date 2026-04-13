import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import stage1Raw from './data/stage1.geojson?raw'
const stage1 = JSON.parse(stage1Raw) as GeoJSON.FeatureCollection
import './MapView.scss'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      projection: 'globe',
      center: [20, 41],
      zoom: 2.5,
    })

    mapRef.current = map

    map.on('load', () => {
      // ── Source ────────────────────────────────────────────────
      map.addSource('stage1', {
        type: 'geojson',
        data: stage1 as GeoJSON.FeatureCollection,
      })

      // ── Route line ────────────────────────────────────────────
      // Outer glow
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'stage1',
        filter: ['==', '$type', 'LineString'],
        paint: {
          'line-color': '#4285f4',
          'line-width': 14,
          'line-opacity': 0.15,
          'line-blur': 4,
        },
      })

      // White outline (casing)
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'stage1',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': 6,
          'line-opacity': 0.9,
        },
      })

      // Blue fill line on top
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'stage1',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#4285f4',
          'line-width': 4,
          'line-opacity': 1,
        },
      })

      // ── Waypoint markers ──────────────────────────────────────
      // White border ring
      map.addLayer({
        id: 'waypoints-border',
        type: 'circle',
        source: 'stage1',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      })

      // Blue dot
      map.addLayer({
        id: 'waypoints',
        type: 'circle',
        source: 'stage1',
        filter: ['==', '$type', 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#4285f4',
          'circle-opacity': 1,
        },
      })

      // ── Fit camera to route ───────────────────────────────────
      const lineFeature = (stage1 as GeoJSON.FeatureCollection).features.find(
        (f) => f.geometry.type === 'LineString',
      ) as GeoJSON.Feature<GeoJSON.LineString> | undefined

      if (lineFeature) {
        const coords = lineFeature.geometry.coordinates
        const bounds = coords.reduce(
          (b, c) => b.extend(c as [number, number]),
          new mapboxgl.LngLatBounds(
            coords[0] as [number, number],
            coords[0] as [number, number],
          ),
        )
        map.fitBounds(bounds, { padding: 60, duration: 1200 })
      }

      // ── Tooltip on hover ─────────────────────────────────────
      const tooltip = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'waypoint-tooltip',
      })

      map.on('mouseenter', 'waypoints', (e) => {
        map.getCanvas().style.cursor = 'pointer'
        const feature = e.features?.[0]
        if (!feature) return
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number]
        const name = feature.properties?.name as string
        tooltip.setLngLat(coords).setHTML(name).addTo(map)
      })

      map.on('mouseleave', 'waypoints', () => {
        map.getCanvas().style.cursor = ''
        tooltip.remove()
      })
    })

    return () => {
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  return <div ref={containerRef} className="map-container" />
}
