import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import stage1Raw from './data/stage1-directions.geojson?raw'
import stage2Raw from './data/stage2-directions.geojson?raw'
import stage3Raw from './data/stage3-directions.geojson?raw'
import stage4Raw from './data/stage4-directions.geojson?raw'
import stage5Raw from './data/stage5-directions.geojson?raw'
import stage6Raw from './data/stage6-directions.geojson?raw'
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

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/satellite-v9',
      projection: 'globe',
      center: [20, 41],
      zoom: 2.5,
    })

    mapRef.current = map

    map.on('load', () => {
      map.addSource('route', {
        type: 'geojson',
        data: allStages,
      })

      // Outer glow
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#4285f4', 'line-width': 14, 'line-opacity': 0.15, 'line-blur': 4 },
      })
      // White casing
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 },
      })
      // Blue fill
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4285f4', 'line-width': 4, 'line-opacity': 1 },
      })
      // Waypoint border
      map.addLayer({
        id: 'waypoints-border',
        type: 'circle',
        source: 'route',
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-opacity': 0.9 },
      })
      // Waypoint dot
      map.addLayer({
        id: 'waypoints',
        type: 'circle',
        source: 'route',
        filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 4, 'circle-color': '#4285f4', 'circle-opacity': 1 },
      })

      // Fit camera to all routes
      const lines = allStages.features.filter((f) => f.geometry.type === 'LineString') as GeoJSON.Feature<GeoJSON.LineString>[]
      if (lines.length) {
        const allCoords = lines.flatMap((f) => f.geometry.coordinates) as [number, number][]
        const bounds = allCoords.reduce(
          (b, c) => b.extend(c),
          new mapboxgl.LngLatBounds(allCoords[0], allCoords[0]),
        )
        map.fitBounds(bounds, { padding: 60, duration: 1200 })
      }

      // Tooltip
      const tooltip = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, className: 'waypoint-tooltip' })

      map.on('mouseenter', 'waypoints', (e) => {
        map.getCanvas().style.cursor = 'pointer'
        const feature = e.features?.[0]
        if (!feature) return
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number]
        tooltip.setLngLat(coords).setHTML(feature.properties?.name as string).addTo(map)
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
