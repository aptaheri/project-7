import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import './Admin.scss'

/** Matches DEFAULT_DAYS on /api/viewer-stats. */
const WINDOW_DAYS = 14

interface Stats {
  email: string
  totalVisits: number
  lastSeen: string | null
  joinedAt: string | null
  days: { date: string; visits: number }[]
}

export default function ViewerStats() {
  const { me, loading: authLoading } = useAuth()
  const { email = '' } = useParams<{ email: string }>()
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const isOwner = me?.role === 'owner'

  const load = useCallback(() => {
    if (!isOwner || !email) return
    setLoading(true)
    fetch(`/api/viewer-stats?email=${encodeURIComponent(email)}`)
      .then(async (res) => {
        const body = (await res.json()) as Stats & { error?: string }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        setStats(body)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [isOwner, email])

  useEffect(load, [load])

  if (authLoading) return <div className="admin admin-message">Loading…</div>

  if (!me?.authenticated) {
    return (
      <div className="admin admin-message">
        Sign in from the <Link to="/track">tracker page</Link> first.
      </div>
    )
  }

  if (!isOwner) {
    return <div className="admin admin-message">This page is for owners only.</div>
  }

  return (
    <div className="admin">
      <div className="admin-content">
        <p className="admin-overline">Project 7</p>
        <h1>{email}</h1>
        <p className="admin-lead">
          <Link to="/track/sharing">Back to sharing</Link>
        </p>

        {loading && <p className="admin-note">Loading…</p>}
        {error && <p className="admin-error">{error}</p>}

        {stats && (
          <>
            {(() => {
              // People were let in at every point in the trip, so a count
              // over a fixed window reads differently for someone who joined
              // yesterday than for someone who has had access for months —
              // this says which, rather than leaving it to be guessed.
              const joinedDaysAgo = stats.joinedAt
                ? Math.floor((Date.now() - new Date(stats.joinedAt).getTime()) / 86_400_000)
                : null
              const recentJoiner = joinedDaysAgo !== null && joinedDaysAgo < WINDOW_DAYS
              return (
                <>
                  <p className="admin-lead">
                    {stats.totalVisits} visit{stats.totalVisits === 1 ? '' : 's'}{' '}
                    {recentJoiner ? 'since joining' : `in the last ${WINDOW_DAYS} days`}
                    {stats.lastSeen &&
                      ` · last opened ${new Date(`${stats.lastSeen}T12:00:00Z`).toLocaleDateString()}`}
                  </p>
                  {stats.joinedAt && (
                    <p className="admin-note">
                      Joined {new Date(stats.joinedAt).toLocaleDateString()}
                      {joinedDaysAgo !== null &&
                        ` (${joinedDaysAgo} day${joinedDaysAgo === 1 ? '' : 's'} ago)`}
                    </p>
                  )}
                </>
              )
            })()}

            {stats.days.length === 0 && (
              <p className="admin-note">No visits recorded in this window.</p>
            )}

            <div className="admin-list">
              {stats.days.map((d) => (
                <div key={d.date} className="admin-row">
                  <span>{new Date(`${d.date}T12:00:00Z`).toLocaleDateString()}</span>
                  <span>{d.visits} visit{d.visits === 1 ? '' : 's'}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
