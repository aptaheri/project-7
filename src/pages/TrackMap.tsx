import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import ElevationChart from '../components/ElevationChart'
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

type Mode = 'production' | 'test'

const MODE_KEY = 'p7.trackMode'

interface Feed {
  latest: LatestFix | null
  trail: [number, number][]
  /** Every stored fix, not the thinned trail. */
  count: number
  distanceKm: number
  distanceTodayKm: number
  timezone: string | null
  elevationGainM: number
  netTodayM: number | null
  profileToday: { m: number; alt: number }[]
  trailPoints: number
  mode: Mode
  devices?: string[]
}

type Status = 'loading' | 'ok' | 'denied' | 'error'

const EMPTY_LINE: GeoJSON.Feature<GeoJSON.LineString> = {
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [] },
}

const MILES_PER_KM = 0.621371
const FEET_PER_METRE = 3.28084

function miles(km: number): string {
  return (km * MILES_PER_KM).toLocaleString(undefined, { maximumFractionDigits: 1 })
}

function feet(metres: number): string {
  return Math.round(metres * FEET_PER_METRE).toLocaleString()
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
  const failuresRef = useRef(0)
  // On a phone the panel covers a third of the map, so it starts collapsed
  // there and open on the roomier desktop layout.
  const [expanded, setExpanded] = useState(() => window.innerWidth > 600)
  // Owners can look at their own test phone instead of the live rider. The
  // choice survives reloads so a debugging session is not lost on refresh, and
  // production is always the default for everyone else.
  // The profile is opt-in: it is the tallest thing in the panel and most
  // viewers only want to know where he is.
  const [showProfile, setShowProfile] = useState(false)
  const [mode, setMode] = useState<Mode>(() =>
    role === 'owner' && localStorage.getItem(MODE_KEY) === 'test' ? 'test' : 'production',
  )

  // Re-renders the "x minutes ago" label without refetching.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), CLOCK_MS)
    return () => clearInterval(id)
  }, [])

  // --- Poll the feed ---
  useEffect(() => {
    let cancelled = false
    // A different rider is somewhere else entirely, so let the map fly there.
    hasCenteredRef.current = false

    async function load() {
      try {
        const res = await fetch(`/api/track?mode=${mode}`)
        if (cancelled) return
        if (res.status === 401 || res.status === 403) {
          setStatus('denied')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as Feed
        if (cancelled) return
        failuresRef.current = 0
        setFeed(data)
        setStatus('ok')
      } catch (error) {
        if (cancelled) return
        console.error('track feed request failed', error)
        failuresRef.current += 1
        // The database sleeps when idle, so a lone failure is usually just a
        // cold start. Only report trouble once it persists.
        if (failuresRef.current >= 2) setStatus('error')
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
  }, [mode])

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

  function switchMode(next: Mode) {
    if (next === mode) return
    localStorage.setItem(MODE_KEY, next)
    setFeed(null)
    setStatus('loading')
    setMode(next)
  }

  function recenter() {
    const map = mapRef.current
    if (!map || !feed?.latest) return
    map.flyTo({ center: [feed.latest.lon, feed.latest.lat], zoom: 11, duration: 1200 })
  }

  const latest = feed?.latest ?? null

  // Every condition resolves to one status line, so the panel keeps its shape
  // and "something is off" always reads the same way. The distinction that
  // matters to a viewer is why there is no position, not which layer failed.
  const indicator: { tone: 'live' | 'stale' | 'offline'; label: string; note: string | null } =
    status === 'denied'
      ? {
          tone: 'offline',
          label: 'Access removed',
          note: 'Your access was revoked. Reload to sign in again.',
        }
      : status === 'error'
        ? {
            tone: 'offline',
            label: 'No connection',
            note: 'Cannot reach the tracker. Retrying every 30 seconds.',
          }
        : status === 'loading'
          ? { tone: 'stale', label: 'Connecting', note: null }
          : !latest
            ? {
                tone: 'stale',
                label: 'No location shared',
                note: 'Nothing has arrived from the phone yet.',
              }
            : freshness(latest.tst) === 'live'
              ? { tone: 'live', label: 'Live', note: null }
              : freshness(latest.tst) === 'stale'
                ? { tone: 'stale', label: 'No recent fix', note: null }
                : { tone: 'offline', label: 'Not sharing location', note: null }

  return (
    <div className="track">
      <div ref={containerRef} className="track-map" />

      <div className="track-panel">
        {mapError && <p className="track-panel-detail">Map unavailable — {mapError}</p>}

        <button
          type="button"
          className="track-status"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
        >
          <span className={`track-dot track-dot-${indicator.tone}`} />
          <span className="track-status-label">{indicator.label}</span>
          {/* Collapsed, this badge is the only clue the map is not the rider. */}
          {mode === 'test' && <span className="track-test-badge">Test</span>}
          {/* Always rendered so the chevron stays pinned right either way. */}
          <span className="track-status-age">{latest ? timeAgo(latest.tst) : ''}</span>
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

        {indicator.note && <p className="track-panel-note">{indicator.note}</p>}

        {expanded && latest && (
          <>
            <dl className="track-stats">
              <div>
                <dt>Position</dt>
                <dd>{latest.lat.toFixed(5)}, {latest.lon.toFixed(5)}</dd>
              </div>
              {latest.vel !== null && (
                <div>
                  <dt>Speed</dt>
                  <dd>{Math.round(latest.vel * MILES_PER_KM)} mph</dd>
                </div>
              )}
              {latest.alt !== null && (
                <div>
                  <dt>Elevation</dt>
                  <dd>{feet(latest.alt)} ft</dd>
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
                  <dd>±{feet(latest.acc)} ft</dd>
                </div>
              )}
              <div title={feed?.timezone ? `Day boundary: ${feed.timezone}` : undefined}>
                <dt>Today</dt>
                <dd>{miles(feed?.distanceTodayKm ?? 0)} mi</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{miles(feed?.distanceKm ?? 0)} mi</dd>
              </div>
              <div>
                <dt>Elevation gain</dt>
                <dd>{feet(feed?.elevationGainM ?? 0)} ft</dd>
              </div>
              <div title="Height now versus the start of his local day">
                <dt>Net today</dt>
                <dd>
                  {feed?.netTodayM == null
                    ? '—'
                    : `${feed.netTodayM >= 0 ? '+' : '−'}${feet(Math.abs(feed.netTodayM))} ft`}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              className="track-profile-toggle"
              onClick={() => setShowProfile((v) => !v)}
              aria-expanded={showProfile}
            >
              <span>Elevation profile</span>
              <svg
                className={`track-chevron${showProfile ? ' open' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {showProfile && <ElevationChart points={feed?.profileToday ?? []} />}

            <button className="track-recenter" onClick={recenter}>
              Recenter
            </button>
          </>
        )}

        {expanded && role === 'owner' && (
          <div className="track-modes">
            <button
              type="button"
              className={`track-mode${mode === 'production' ? ' active' : ''}`}
              onClick={() => switchMode('production')}
            >
              Production
            </button>
            <button
              type="button"
              className={`track-mode${mode === 'test' ? ' active' : ''}`}
              onClick={() => switchMode('test')}
            >
              Test
            </button>
          </div>
        )}

        {expanded && role === 'owner' && feed?.devices && feed.devices.length > 0 && (
          <p className="track-devices">Devices seen: {feed.devices.join(', ')}</p>
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
