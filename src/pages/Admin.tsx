import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import type { Role } from '../lib/auth'
import './Admin.scss'

interface Viewer {
  email: string
  role: Role
  created_at: string
  updated_at: string
  granted_by: string | null
}

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  viewer: 'Viewer',
  pending: 'Pending',
}

export default function Admin() {
  const { me, loading: authLoading } = useAuth()
  const [viewers, setViewers] = useState<Viewer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [invite, setInvite] = useState('')

  const isOwner = me?.role === 'owner'

  const load = useCallback(() => {
    if (!isOwner) return
    setLoading(true)
    fetch('/api/viewers')
      .then(async (res) => {
        const body = (await res.json()) as { viewers?: Viewer[]; error?: string }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        setViewers(body.viewers ?? [])
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [isOwner])

  useEffect(load, [load])

  async function mutate(body: Record<string, unknown>, key: string) {
    setBusy(key)
    try {
      const res = await fetch('/api/viewers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const parsed = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`)
      load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (authLoading) {
    return <div className="admin admin-message">Loading…</div>
  }

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
        <h1>Tracker access</h1>
        <p className="admin-lead">
          Anyone who signs in is recorded here as pending. Grant the viewer role
          to let them see the live map. Changes take effect on their next poll.
        </p>

        <form
          className="admin-invite"
          onSubmit={(e) => {
            e.preventDefault()
            const email = invite.trim()
            if (!email) return
            mutate({ email, role: 'viewer' }, email).then(() => setInvite(''))
          }}
        >
          <input
            type="email"
            placeholder="Grant access to an email address"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
          <button type="submit" disabled={busy !== null}>
            Grant viewer
          </button>
        </form>

        {error && <p className="admin-error">{error}</p>}
        {loading && <p className="admin-note">Loading…</p>}

        {!loading && viewers.length === 0 && (
          <p className="admin-note">Nobody has signed in yet.</p>
        )}

        <div className="admin-list">
          {viewers.map((v) => (
            <div key={v.email} className="admin-row">
              <div className="admin-row-main">
                <span className="admin-email">{v.email}</span>
                <span className={`admin-role admin-role-${v.role}`}>{ROLE_LABELS[v.role]}</span>
              </div>
              <div className="admin-row-actions">
                {v.role !== 'viewer' && (
                  <button
                    disabled={busy === v.email}
                    onClick={() => mutate({ email: v.email, role: 'viewer' }, v.email)}
                  >
                    Make viewer
                  </button>
                )}
                {v.role !== 'owner' && (
                  <button
                    disabled={busy === v.email}
                    onClick={() => mutate({ email: v.email, role: 'owner' }, v.email)}
                  >
                    Make owner
                  </button>
                )}
                {v.email !== me.email && (
                  <button
                    className="admin-danger"
                    disabled={busy === v.email}
                    onClick={() => mutate({ email: v.email, remove: true }, v.email)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
