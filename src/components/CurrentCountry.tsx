import { useEffect, useState } from 'react'
import './CurrentCountry.scss'

/**
 * "Currently in — Spain 🇪🇸" on the homepage.
 *
 * The one piece of live location that is public. /api/where returns a country
 * and nothing else, so there is nothing here that needs the sign-in wall the
 * tracker sits behind.
 *
 * Renders nothing until it knows, and nothing at all if it never finds out: an
 * empty space reads as a design choice, where "Currently in — unknown" reads as
 * a broken website.
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
    <div className="current-country">
      <span className="current-country-label">Currently in</span>
      <span className="current-country-value">
        {where.country}
        {/* The flag says "Spain" a second time to a screen reader, so it is
            decoration here rather than content. */}
        {where.flag && (
          <span className="current-country-flag" aria-hidden="true">{where.flag}</span>
        )}
      </span>
    </div>
  )
}
