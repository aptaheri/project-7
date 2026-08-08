import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN

const POLL_MS = 30_000
const CLOCK_MS = 15_000

// A fix older than this means the phone has been out of coverage or asleep.
const STALE_MS = 30 * 60 * 1000
const VERY_STALE_MS = 6 * 60 * 60 * 1000

const STAGE_URLS = [
  '/geojson/stage1-map.geojson',
  '/geojson/stage1a-map.geojson',
  '/geojson/stage2-map.geojson',
  '/geojson/stage3-map.geojson',
  '/geojson/stage4-map.geojson',
  '/geojson/stage5-map.geojson',
  '/geojson/stage6-map.geojson',
  '/geojson/stage7-map.geojson',
]

interface LatestFix {
  tst: string
  lat: number
  lon: number
  acc: number | null
  alt: number | null
  vel: number | null
  batt: number | null
  bs: number | null
  conn: string | null
  tid: string | null
}

interface Feed {
  latest: LatestFix | null
  trail: [number, number][]
  /** Every stored fix, not the thinned trail. */
  count: number
  distanceKm: number
  elevationGainM: number
  trailPoints: number
}

type Status = 'loading' | 'ok' | 'denied' | 'error'

const EMPTY_LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function freshness(iso: string): 'live' | 'stale' | 'offline' {
  const age = Date.now() - new Date(iso).getTime()
  if (age > VERY_STALE_MS) return 'offline'
  if (age > STALE_MS) return 'stale'
  return 'live'
}

interface Props {
  email: string
  role: string
}

export default function TrackMap({ email, role }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markerRef = useRef<mapboxgl.Marker | null>(null)
  const hasCenteredRef = useRef(false)

  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [feed, setFeed] = useState<Feed | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  // On a phone the panel covers a third of the map, so it starts collapsed
  // there and open on the roomier desktop layout.
  const [expanded, setExpanded] = useState(() => window.innerWidth > 600)

  // Re-renders the "x minutes ago" label without refetching.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  // --- Poll the feed ---
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch('/api/track')
        if (cancelled) return
        if (res.status === 401 || res.status === 403) {
          setStatus('denied')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as Feed
        if (cancelled) return
        setFeed(data)
        setStatus('ok')
      } catch (error) {
        if (!cancelled) {
          console.error('track feed request failed', error)
          setStatus('error')
        }
      }
    }

    load()
    const id = setInterval(load, POLL_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // --- Map setup (once) ---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    // Mapbox throws outright when WebGL is unavailable — blocked by a browser
    // setting, an extension, or old hardware. Uncaught, that takes the whole
    // React tree down and the visitor gets a blank page with no explanation.
    let map: mapboxgl.Map
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/satellite-streets-v12',
        projection: 'globe',
        center: [20, 41],
        zoom: 2.5,
      })
    } catch (error) {
      console.error('map failed to initialise', error)
      setMapError(
        error instanceof Error ? error.message : 'This browser could not display the map.',
      )
      return
    }
    mapRef.current = map

    map.on('error', (e) => console.error('mapbox error', e.error ?? e))

    map.on('load', async () => {
      map.setFog({
        color: 'rgb(20, 20, 30)',
        'high-color': 'rgb(10, 10, 20)',
        'horizon-blend': 0.08,
        'space-color': 'rgb(5, 5, 15)',
        'star-intensity': 0.4,
      })

      // Planned route, drawn muted so the travelled trail reads on top of it.
      const stages = await Promise.all(
        STAGE_URLS.map((url) =>
          fetch(url)
            .then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
            // One unreachable stage file should not stop the live trail drawing.
            .catch((): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] })),
        ),
      )
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: stages.flatMap((s) => s.features) },
      })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', '$type', 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#4285f4', 'line-width': 2.5, 'line-opacity': 0.45 },
      })

      // Where he has actually been.
      map.addSource('trail', { type: 'geojson', data: EMPTY_LINE })
      map.addLayer({
        id: 'trail-glow',
        type: 'line',
        source: 'trail',
        paint: { 'line-color': '#22d3a6', 'line-width': 12, 'line-opacity': 0.18, 'line-blur': 4 },
      })
      map.addLayer({
        id: 'trail-line',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#22d3a6', 'line-width': 3.5 },
      })

      setMapReady(true)
    })

    return () => {
      markerRef.current?.remove()
      markerRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  // --- Push feed data onto the map ---
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !feed) return

    const trail = map.getSource('trail') as mapboxgl.GeoJSONSource | undefined
    trail?.setData({
      ...EMPTY_LINE,
      geometry: { type: 'LineString', coordinates: feed.trail },
    })

    if (!feed.latest) return
    const position: [number, number] = [feed.latest.lon, feed.latest.lat]

    if (!markerRef.current) {
      const el = document.createElement('div')
      el.className = 'track-marker'
      el.innerHTML = '<span class="track-marker-pulse"></span><span class="track-marker-dot"></span>'
      markerRef.current = new mapboxgl.Marker({ element: el }).setLngLat(position).addTo(map)
    } else {
      markerRef.current.setLngLat(position)
    }

    // Only take the camera on the first fix; after that the view is the user's.
    if (!hasCenteredRef.current) {
      hasCenteredRef.current = true
      map.flyTo({ center: position, zoom: 9, duration: 2000 })
    }
  }, [feed, mapReady])

  function recenter() {
    const map = mapRef.current
    if (!map || !feed?.latest) return
    map.flyTo({ center: [feed.latest.lon, feed.latest.lat], zoom: 11, duration: 1200 })
  }

  const latest = feed?.latest ?? null
  const state = latest ? freshness(latest.tst) : null

  return (
    <div className="track">
      <div ref={containerRef} className="track-map" />

      <div className="track-panel">
        {mapError && (
          <>
            <p className="track-panel-title">Map unavailable</p>
            <p className="track-panel-note">
              The map could not start in this browser. The position below is
              still live.
            </p>
            <pre className="track-panel-detail">{mapError}</pre>
          </>
        )}

        {status === 'loading' && <p className="track-panel-title">Loading…</p>}

        {status === 'denied' && (
          <>
            <p className="track-panel-title">Access removed</p>
            <p className="track-panel-note">Your access was revoked. Reload to sign in again.</p>
          </>
        )}

        {status === 'error' && (
          <>
            <p className="track-panel-title">Feed unavailable</p>
            <p className="track-panel-note">Retrying every 30 seconds.</p>
          </>
        )}

        {status === 'ok' && !latest && (
          <>
            <p className="track-panel-title">No fixes yet</p>
            <p className="track-panel-note">Waiting for the first location from OwnTracks.</p>
          </>
        )}

        {status === 'ok' && latest && (
          <>
            <button
              type="button"
              className="track-status"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={expanded ? 'Hide details' : 'Show details'}
            >
              <span className={`track-dot track-dot-${state}`} />
              <span className="track-status-label">
                {state === 'live' ? 'Live' : state === 'stale' ? 'No recent fix' : 'Offline'}
              </span>
              <span className="track-status-age">{timeAgo(latest.tst)}</span>
              <svg
                className={`track-chevron${expanded ? ' open' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {expanded && (
            <dl className="track-stats">
              <div>
                <dt>Position</dt>
                <dd>{latest.lat.toFixed(5)}, {latest.lon.toFixed(5)}</dd>
              </div>
              {latest.vel !== null && (
                <div>
                  <dt>Speed</dt>
                  <dd>{Math.round(latest.vel)} km/h</dd>
                </div>
              )}
              {latest.alt !== null && (
                <div>
                  <dt>Elevation</dt>
                  <dd>{Math.round(latest.alt)} m</dd>
                </div>
              )}
              {latest.batt !== null && (
                <div>
                  <dt>Phone battery</dt>
                  <dd>{latest.batt}%</dd>
                </div>
              )}
              {latest.acc !== null && (
                <div>
                  <dt>Accuracy</dt>
                  <dd>±{Math.round(latest.acc)} m</dd>
                </div>
              )}
              <div>
                <dt>Distance</dt>
                <dd>{(feed?.distanceKm ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} km</dd>
              </div>
              <div>
                <dt>Elevation gain</dt>
                <dd>{Math.round(feed?.elevationGainM ?? 0).toLocaleString()} m</dd>
              </div>
            </dl>
            )}

            {expanded && (
              <button className="track-recenter" onClick={recenter}>
                Recenter
              </button>
            )}
          </>
        )}

        {/* Signing out lives in the navbar; this just says who you are. */}
        {expanded && (
          <div className="track-account">
            <span className="track-account-email">{email}</span>
            {role === 'owner' && <span className="track-account-role">Owner</span>}
          </div>
        )}
      </div>
    </div>
  )
}
