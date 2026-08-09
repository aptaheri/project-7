import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import ElevationChart from '../components/ElevationChart'
import { BACKFILL_BLUE, LIVE_BLUE, ROUTE_RED } from '../lib/mapColors'
import {
  compass, dateIn, daylight, fahrenheit, mph, timeIn, weatherDescription,
} from '../lib/conditions'
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
  countToday: number
  distanceKm: number
  distanceTodayKm: number
  timezone: string | null
  elevationGainM: number
  netTodayM: number | null
  profileToday: { m: number; alt: number }[]
  days: DaySummary[]
  leg: {
    date: string
    kind: 'ride' | 'rest'
    from: string | null
    to: string
    plannedMiles: number | null
    destination: [number, number]
    distanceToDestinationKm: number
    daysFromSchedule: number
  } | null
  backfillTrail: [number, number][]
  backfillKm: number
  local: {
    sunriseUtc: string | null
    sunsetUtc: string | null
    weather: {
      temperatureC: number
      windKph: number
      windDirection: number
      code: number
    } | null
  } | null
  trailPoints: number
  mode: Mode
  devices?: string[]
}

type Status = 'loading' | 'ok' | 'denied' | 'error'

/** Panels swap rather than stack; add a name here to nest another screen. */
type PanelView = 'main' | 'elevation' | 'device' | 'local' | 'day'

interface DaySummary {
  date: string
  reconstructed: boolean
  distanceKm: number
  elapsedSeconds: number
  fixes: number
  start: [number, number]
  end: [number, number]
  gainM: number
  netM: number | null
  highM: number | null
  lowM: number | null
}

const EMPTY_POINTS: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** "2026-08-10" rendered as "Mon 10 Aug", without shifting into another day. */
function formatDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(d)
}

function duration(seconds: number): string {
  // Round to minutes first and then split, or 23h 59m 59s renders as "23h 60m".
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

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
  role: string
}

export default function TrackMap({ role }: Props) {
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
  // The panel swaps between views instead of stacking sections, so it stays the
  // same height however much detail is nested inside it.
  const [view, setView] = useState<PanelView>('main')
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  // Read inside a map click handler, which is registered once and would
  // otherwise capture the first render's state forever.
  const daysRef = useRef<DaySummary[]>([])
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
        paint: { 'line-color': ROUTE_RED, 'line-width': 2.5, 'line-opacity': 0.5 },
      })

      // Reconstructed riding from before the tracker existed. Dashed and
      // dimmer so it never reads as a measured track.
      map.addSource('backfill', { type: 'geojson', data: EMPTY_LINE })
      map.addLayer({
        id: 'backfill-line',
        type: 'line',
        source: 'backfill',
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': BACKFILL_BLUE,
          'line-width': 3.5,
          'line-opacity': 0.9,
          'line-dasharray': [2, 1.8],
        },
      })

      // Where he has actually been.
      map.addSource('trail', { type: 'geojson', data: EMPTY_LINE })
      map.addLayer({
        id: 'trail-glow',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': LIVE_BLUE, 'line-width': 18, 'line-opacity': 0.18, 'line-blur': 5 },
      })
      // A casing keeps the blue legible over dark forest and pale rock alike.
      map.addLayer({
        id: 'trail-casing',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 8.5, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'trail-line',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': LIVE_BLUE, 'line-width': 5 },
      })

      // Where each day ended. Added above the trail so they stay clickable.
      map.addSource('days', { type: 'geojson', data: EMPTY_POINTS })
      map.addLayer({
        id: 'day-markers',
        type: 'circle',
        source: 'days',
        paint: {
          'circle-radius': 6,
          'circle-color': [
            'case', ['get', 'reconstructed'], 'rgba(10,10,15,0.9)', '#ffffff',
          ],
          'circle-stroke-width': 3,
          'circle-stroke-color': [
            'case', ['get', 'reconstructed'], BACKFILL_BLUE, LIVE_BLUE,
          ],
        },
      })

      map.on('click', 'day-markers', (e) => {
        const date = e.features?.[0]?.properties?.date
        if (typeof date !== 'string') return
        const day = daysRef.current.find((d) => d.date === date)
        if (!day) return
        setSelectedDay(date)
        setView('day')
        setExpanded(true)
        map.flyTo({ center: day.end, zoom: 10, duration: 900 })
      })
      map.on('mouseenter', 'day-markers', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'day-markers', () => {
        map.getCanvas().style.cursor = ''
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

    const backfill = map.getSource('backfill') as mapboxgl.GeoJSONSource | undefined
    backfill?.setData({
      ...EMPTY_LINE,
      geometry: { type: 'LineString', coordinates: feed.backfillTrail },
    })

    daysRef.current = feed.days
    const daySource = map.getSource('days') as mapboxgl.GeoJSONSource | undefined
    daySource?.setData({
      type: 'FeatureCollection',
      features: feed.days.map((d) => ({
        type: 'Feature',
        properties: { date: d.date, reconstructed: d.reconstructed },
        geometry: { type: 'Point', coordinates: d.end },
      })),
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
    map.flyTo({ center: [feed.latest.lon, feed.latest.lat], zoom: 13.5, duration: 1200 })
  }

  const latest = feed?.latest ?? null
  const profileAlts = feed?.profileToday.map((p) => p.alt) ?? []
  const profileHigh = profileAlts.length ? Math.max(...profileAlts) : null
  const profileLow = profileAlts.length ? Math.min(...profileAlts) : null

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

        {/* Only rendered when the matcher is confident. No leg means no honest
            destination to name, and a gap beats a guess. */}
        {expanded && view === 'main' && feed?.leg && (
          <div className="track-leg">
            <p className="track-leg-route">
              {feed.leg.kind === 'rest'
                ? `Rest day in ${feed.leg.to}`
                : `${feed.leg.from ?? '?'} → ${feed.leg.to}`}
            </p>
            <p className="track-leg-meta">
              {feed.leg.kind === 'ride' && feed.leg.plannedMiles !== null && (
                <span>{feed.leg.plannedMiles} mi planned</span>
              )}
              {feed.leg.kind === 'ride' && (
                <span>{miles(feed.leg.distanceToDestinationKm)} mi to go</span>
              )}
              {feed.leg.daysFromSchedule !== 0 && (
                <span className="track-leg-drift">
                  {Math.abs(feed.leg.daysFromSchedule)}d{' '}
                  {feed.leg.daysFromSchedule < 0 ? 'behind' : 'ahead'}
                </span>
              )}
            </p>
          </div>
        )}

        {expanded && view === 'main' && latest && (
          <>
            <dl className="track-stats">
              {latest.vel !== null && (
                <div>
                  <dt>Speed</dt>
                  <dd>{Math.round(latest.vel * MILES_PER_KM)} mph</dd>
                </div>
              )}
              <div title={feed?.timezone ? `Day boundary: ${feed.timezone}` : undefined}>
                <dt>Today</dt>
                <dd>{miles(feed?.distanceTodayKm ?? 0)} mi</dd>
              </div>
              {/* Everything ridden since Lisbon, measured and reconstructed
                  together. The split stays in the tooltip rather than a row. */}
              <div
                title={
                  (feed?.backfillKm ?? 0) > 0
                    ? `${miles(feed?.distanceKm ?? 0)} mi tracked, ${miles(feed?.backfillKm ?? 0)} mi reconstructed from before the tracker existed`
                    : undefined
                }
              >
                <dt>Total</dt>
                <dd>{miles((feed?.distanceKm ?? 0) + (feed?.backfillKm ?? 0))} mi</dd>
              </div>
            </dl>

            {/* Opens a replacement view rather than growing the panel, which on
                a phone would push it past the height of the screen. */}
            <button
              type="button"
              className="track-nav-row"
              onClick={() => setView('elevation')}
            >
              <span className="track-nav-label">Elevation</span>
              <span className="track-nav-value">
                {latest.alt === null ? '—' : `${feet(latest.alt)} ft`}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>

            {feed?.timezone && (
              <button
                type="button"
                className="track-nav-row"
                onClick={() => setView('local')}
              >
                <span className="track-nav-label">Local</span>
                <span className="track-nav-value">{timeIn(feed.timezone)}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}

            <button
              type="button"
              className="track-nav-row"
              onClick={() => setView('device')}
            >
              <span className="track-nav-label">Device</span>
              <span className="track-nav-value">
                {latest.acc === null ? '—' : `±${feet(latest.acc)} ft`}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>

            <button className="track-recenter" onClick={recenter}>
              Recenter
            </button>
          </>
        )}

        {expanded && view === 'day' && (() => {
          const day = feed?.days.find((d) => d.date === selectedDay)
          if (!day) {
            return (
              <>
                <div className="track-subhead">
                  <button
                    type="button"
                    className="track-back"
                    onClick={() => setView('main')}
                    aria-label="Back to stats"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="track-subhead-title">Day</span>
                </div>
                <p className="track-panel-note">That day is no longer in the feed.</p>
              </>
            )
          }
          return (
            <>
              <div className="track-subhead">
                <button
                  type="button"
                  className="track-back"
                  onClick={() => setView('main')}
                  aria-label="Back to stats"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                </button>
                <span className="track-subhead-title">{formatDay(day.date)}</span>
                {day.reconstructed && <span className="track-test-badge">Reconstructed</span>}
              </div>

              {day.reconstructed && (
                <p className="track-panel-note">
                  Inferred from the planned route and his own account. Distances
                  are estimates and there is no elevation data.
                </p>
              )}

              <dl className="track-stats">
                <div>
                  <dt>Distance</dt>
                  <dd>{miles(day.distanceKm)} mi</dd>
                </div>
                <div title="First fix to last fix, including stops">
                  <dt>Elapsed</dt>
                  <dd>{duration(day.elapsedSeconds)}</dd>
                </div>
                {!day.reconstructed && (
                  <div>
                    <dt>Elevation gain</dt>
                    <dd>{feet(day.gainM)} ft</dd>
                  </div>
                )}
                {!day.reconstructed && (
                <div>
                  <dt>Net</dt>
                  <dd>
                    {day.netM == null
                      ? '—'
                      : `${day.netM >= 0 ? '+' : '−'}${feet(Math.abs(day.netM))} ft`}
                  </dd>
                </div>
                )}
                {!day.reconstructed && (
                  <div>
                    <dt>High</dt>
                    <dd>{day.highM == null ? '—' : `${feet(day.highM)} ft`}</dd>
                  </div>
                )}
                {!day.reconstructed && (
                  <div>
                    <dt>Low</dt>
                    <dd>{day.lowM == null ? '—' : `${feet(day.lowM)} ft`}</dd>
                  </div>
                )}
                <div>
                  <dt>Fixes</dt>
                  <dd>{day.fixes.toLocaleString()}</dd>
                </div>
              </dl>
            </>
          )
        })()}

        {expanded && view === 'local' && (
          <>
            <div className="track-subhead">
              <button
                type="button"
                className="track-back"
                onClick={() => setView('main')}
                aria-label="Back to stats"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="track-subhead-title">Where he is</span>
            </div>

            <dl className="track-stats">
              <div>
                <dt>Local time</dt>
                <dd>{feed?.timezone ? timeIn(feed.timezone) : '—'}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{feed?.timezone ? dateIn(feed.timezone) : '—'}</dd>
              </div>
              <div title="Timezone taken from his coordinates, not the server">
                <dt>Timezone</dt>
                <dd>{feed?.timezone?.split('/').pop()?.replace(/_/g, ' ') ?? '—'}</dd>
              </div>
              <div>
                <dt>Sunrise</dt>
                <dd>
                  {feed?.local?.sunriseUtc && feed.timezone
                    ? timeIn(feed.timezone, new Date(feed.local.sunriseUtc))
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Sunset</dt>
                <dd>
                  {feed?.local?.sunsetUtc && feed.timezone
                    ? timeIn(feed.timezone, new Date(feed.local.sunsetUtc))
                    : '—'}
                </dd>
              </div>
              {(() => {
                const left = daylight(
                  feed?.local?.sunriseUtc ?? null,
                  feed?.local?.sunsetUtc ?? null,
                )
                return left ? (
                  <div>
                    <dt>{left.label}</dt>
                    <dd>{left.value}</dd>
                  </div>
                ) : null
              })()}
              {feed?.local?.weather && (
                <>
                  <div>
                    <dt>Weather</dt>
                    <dd>{weatherDescription(feed.local.weather.code)}</dd>
                  </div>
                  <div>
                    <dt>Temperature</dt>
                    <dd>{fahrenheit(feed.local.weather.temperatureC)}</dd>
                  </div>
                  <div title="Direction the wind is coming from">
                    <dt>Wind</dt>
                    <dd>
                      {mph(feed.local.weather.windKph)} {compass(feed.local.weather.windDirection)}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </>
        )}

        {expanded && view === 'device' && (
          <>
            <div className="track-subhead">
              <button
                type="button"
                className="track-back"
                onClick={() => setView('main')}
                aria-label="Back to stats"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="track-subhead-title">Device</span>
            </div>

            <dl className="track-stats">
              <div>
                <dt>Position</dt>
                <dd>
                  {latest ? `${latest.lat.toFixed(5)}, ${latest.lon.toFixed(5)}` : '—'}
                </dd>
              </div>
              <div>
                <dt>Accuracy</dt>
                <dd>{latest?.acc == null ? '—' : `±${feet(latest.acc)} ft`}</dd>
              </div>
              <div>
                <dt>Phone battery</dt>
                <dd>{latest?.batt == null ? '—' : `${latest.batt}%`}</dd>
              </div>
              <div title="Fixes recorded so far today">
                <dt>Fixes today</dt>
                <dd>{(feed?.countToday ?? 0).toLocaleString()}</dd>
              </div>
              <div title="Every measured fix since tracking began">
                <dt>Fixes all time</dt>
                <dd>{(feed?.count ?? 0).toLocaleString()}</dd>
              </div>
            </dl>
          </>
        )}

        {expanded && view === 'elevation' && (
          <>
            <div className="track-subhead">
              <button
                type="button"
                className="track-back"
                onClick={() => setView('main')}
                aria-label="Back to stats"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <span className="track-subhead-title">Elevation</span>
            </div>

            <ElevationChart points={feed?.profileToday ?? []} />

            <dl className="track-stats">
              <div>
                <dt>Current</dt>
                <dd>{latest?.alt == null ? '—' : `${feet(latest.alt)} ft`}</dd>
              </div>
              <div title="Highest point of today's ride">
                <dt>High today</dt>
                <dd>{profileHigh === null ? '—' : `${feet(profileHigh)} ft`}</dd>
              </div>
              <div title="Lowest point of today's ride">
                <dt>Low today</dt>
                <dd>{profileLow === null ? '—' : `${feet(profileLow)} ft`}</dd>
              </div>
              <div title="Total climbing today, ignoring GPS wobble">
                <dt>Gain today</dt>
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
          </>
        )}

        {expanded && view === 'main' && role === 'owner' && (
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

        {expanded && view === 'main' && role === 'owner' && feed?.devices && feed.devices.length > 0 && (
          <p className="track-devices">
            Devices: {feed.devices.map((d) => d.replace(/^owntracks\//, '')).join(', ')}
          </p>
        )}

      </div>
    </div>
  )
}
