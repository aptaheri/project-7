const MILES_PER_KM = 0.621371
const FEET_PER_METRE = 3.28084

// A viewBox rather than pixels, so the chart scales with the panel width.
const W = 240
const H = 68

interface Point {
  m: number
  alt: number
}

interface Props {
  points: Point[]
}

/**
 * The day's ride profile: distance travelled against altitude.
 *
 * Drawn as a plain SVG path rather than pulling in a charting library — the
 * whole thing is two polylines, and a chart library would be many times the
 * size of everything else on this page.
 */
export default function ElevationChart({ points }: Props) {
  if (points.length < 3) {
    return <p className="track-panel-note">Not enough of today's ride yet.</p>
  }

  const xs = points.map((p) => p.m)
  const ys = points.map((p) => p.alt)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  // A flat ride would divide by zero and, worse, draw a line through the middle
  // implying variation that is not there — so pad it into a visibly flat band.
  const spanX = maxX - minX || 1
  const rawSpanY = maxY - minY
  const spanY = rawSpanY < 1 ? 1 : rawSpanY

  const x = (m: number) => ((m - minX) / spanX) * W
  const y = (alt: number) =>
    rawSpanY < 1 ? H / 2 : H - ((alt - minY) / spanY) * (H - 6) - 3

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.m).toFixed(1)},${y(p.alt).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`

  const feet = (metres: number) => Math.round(metres * FEET_PER_METRE).toLocaleString()
  const miles = (metres: number) =>
    ((metres / 1000) * MILES_PER_KM).toLocaleString(undefined, { maximumFractionDigits: 1 })

  return (
    <div className="elevation">
      <svg
        className="elevation-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Elevation profile: ${feet(minY)} to ${feet(maxY)} feet over ${miles(maxX)} miles`}
      >
        <path className="elevation-area" d={area} />
        <path className="elevation-line" d={line} />
      </svg>

      <div className="elevation-axis">
        <span>{feet(minY)}–{feet(maxY)} ft</span>
        <span>{miles(maxX)} mi</span>
      </div>
    </div>
  )
}
