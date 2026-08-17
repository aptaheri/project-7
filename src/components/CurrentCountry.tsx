import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import './CurrentCountry.scss'

/**
 * "Current location: Spain 🇪🇸" on the homepage, and the way in to the tracker.
 *
 * The country is the one piece of live location that is public: /api/where
 * returns a country and nothing else, so there is nothing here that needs the
 * sign-in wall the map sits behind.
 *
 * The whole pill is a link, and a chevron is the only thing that says so — the
 * line reads better as a plain statement than as a button, and that was the
 * call. It does mean the homepage never mentions that a live map exists or that
 * access can be asked for, so anyone arriving cold has to be curious enough to
 * click a status label. /track is where the gate gets explained; it tells a new
 * account that an owner has to approve it, and records the request on sign-in.
 *
 * Nothing here varies by account, so it costs no auth check: everyone goes to
 * the same place and that page sorts out who they are.
 *
 * Renders nothing until it knows the country, and nothing at all if it never
 * finds out: an empty space reads as a design choice, where
 * "Current location: unknown" reads as a broken website.
 */

interface Where {
  country: string | null
  code: string | null
  flag: string | null
}

export default function CurrentCountry() {
  const [where, setWhere] = useState<Where | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/where')
      .then((res) => (res.ok ? (res.json() as Promise<Where>) : null))
      .then((body) => {
        if (!cancelled && body?.country) setWhere(body)
      })
      .catch(() => {
        // A missing line is the intended failure mode; nothing to report.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!where?.country) return null

  return (
    <Link to="/track" className="current-country" title="Live tracking">
      {/* The text is one block and the chevron sits outside it, so when the pill
          wraps on a narrow phone the chevron stays centred against the whole
          height at the right edge instead of trailing the last line. */}
      <span className="current-country-text">
        <span className="current-country-label">Current location:</span>
        <span className="current-country-value">
          {where.country}
          {/* The flag says "Spain" a second time to a screen reader, so it is
              decoration here rather than content. */}
          {where.flag && (
            <span className="current-country-flag" aria-hidden="true">{where.flag}</span>
          )}
        </span>
      </span>
      {/* Cropped to the stroke rather than the usual 0 0 24 24: at this size the
          empty quarter either side of a chevron path shows up as the pill
          looking wider-padded on the right than on the left. The stroke is
          scaled to match — 1.55 units across this box draws the same 1.35px
          hairline the navbar's caret gets from 2.5 across a full 24. */}
      <svg
        className="current-country-chevron"
        viewBox="7.5 4.5 9 15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.55"
        aria-hidden="true"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
      {/* A chevron is a hint to the eye and nothing at all to a screen reader,
          which would otherwise announce a link named after a country with no
          clue where it goes. */}
      <span className="current-country-destination">Live tracking</span>
    </Link>
  )
}
