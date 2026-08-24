import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import type { Role } from '../lib/auth'
import './Admin.scss'

type EmailPref = 'daily' | 'none'

interface Viewer {
  email: string
  role: Role
  email_pref: EmailPref
  first_name: string | null
  last_name: string | null
  created_at: string
  updated_at: string
  granted_by: string | null
  /** Owner by way of TRACK_OWNER_EMAILS, so the role cannot be changed here. */
  bootstrap: boolean
}

/**
 * Why a bootstrap owner's role is fixed, shown on the disabled buttons.
 *
 * These addresses are re-seeded as owners whenever this page loads and
 * re-promoted whenever they sign in — that is what stops everyone being locked
 * out — so removing one succeeds against the database and is undone a moment
 * later, taking any name that was typed with it.
 */
const BOOTSTRAP_REASON =
  'Listed in TRACK_OWNER_EMAILS. Remove it from that setting in Netlify to change this.'

/** The two name fields as they are being typed, keyed by email. */
type NameDrafts = Record<string, { first: string; last: string }>

function draftFor(drafts: NameDrafts, viewer: Viewer): { first: string; last: string } {
  return drafts[viewer.email] ?? {
    first: viewer.first_name ?? '',
    last: viewer.last_name ?? '',
  }
}

/** Whether what is typed differs from what is stored, so Save can stay quiet. */
function isDirty(drafts: NameDrafts, viewer: Viewer): boolean {
  const draft = draftFor(drafts, viewer)
  return (
    draft.first.trim() !== (viewer.first_name ?? '') ||
    draft.last.trim() !== (viewer.last_name ?? '')
  )
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
  const [preview, setPreview] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<NameDrafts>({})

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

  async function mutate(body: Record<string, unknown>, key: string): Promise<boolean> {
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
      setError(null)
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    } finally {
      setBusy(null)
    }
  }

  function editName(viewer: Viewer, patch: Partial<{ first: string; last: string }>) {
    setDrafts((current) => ({
      ...current,
      [viewer.email]: { ...draftFor(current, viewer), ...patch },
    }))
  }

  async function saveName(viewer: Viewer) {
    const draft = draftFor(drafts, viewer)
    const ok = await mutate(
      { email: viewer.email, firstName: draft.first.trim(), lastName: draft.last.trim() },
      viewer.email,
    )
    // The draft is dropped only once it is stored, so a failed save leaves what
    // was typed on screen to try again rather than throwing it away.
    if (!ok) return
    setDrafts((current) => {
      const next = { ...current }
      delete next[viewer.email]
      return next
    })
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

        <p className="admin-lead">
          <Link to="/track/route">Change the route</Link> — where a day ends, how
          far it was, a rest day moved. John can do this himself from the road.
        </p>

        <div className="admin-email-check">
          <button
            type="button"
            onClick={() => {
              setPreview('Checking…')
              fetch('/api/email-admin')
                .then((res) => res.json())
                .then((body: { reason?: string; subject?: string; recipients?: string[] }) =>
                  setPreview(
                    [
                      body.reason,
                      body.subject,
                      body.recipients ? `${body.recipients.length} subscribed` : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  ),
                )
                .catch((err: Error) => setPreview(err.message))
            }}
          >
            Check today's email
          </button>
          <a href="/api/email-admin?format=html&force=1" target="_blank" rel="noreferrer">
            See what it looks like
          </a>
          <button
            type="button"
            onClick={() => {
              setPreview('Sending…')
              // force, because a test send is wanted now rather than only on a
              // morning he happens to be riding.
              fetch('/api/email-admin?send=me&force=1')
                .then((res) => res.json())
                .then((body: { reason?: string }) => setPreview(body.reason ?? 'Done'))
                .catch((err: Error) => setPreview(err.message))
            }}
          >
            Send one to me
          </button>
          {preview && <p className="admin-note">{preview}</p>}
        </div>

        <form
          className="admin-invite"
          onSubmit={(e) => {
            e.preventDefault()
            const email = invite.trim()
            if (!email) return
            void mutate({ email, role: 'viewer' }, email).then((ok) => {
              if (ok) setInvite('')
            })
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
                <div className="admin-identity">
                  {/* The name leads when there is one: an address is a poor way
                      to recognise somebody, which is the whole reason names are
                      collected. Without one the address takes the top line
                      rather than leaving a blank where a name should be. */}
                  <span className="admin-name">
                    {[v.first_name, v.last_name].filter(Boolean).join(' ') || v.email}
                  </span>
                  {(v.first_name || v.last_name) && (
                    <span className="admin-email">{v.email}</span>
                  )}
                </div>
                <span className={`admin-role admin-role-${v.role}`}>{ROLE_LABELS[v.role]}</span>
                {v.bootstrap && (
                  <span className="admin-pref" title={BOOTSTRAP_REASON}>
                    Always owner
                  </span>
                )}
                {v.role !== 'pending' && v.email_pref === 'none' && (
                  <span className="admin-pref">No emails</span>
                )}
              </div>

              <form
                className="admin-name-edit"
                onSubmit={(e) => {
                  e.preventDefault()
                  void saveName(v)
                }}
              >
                <input
                  type="text"
                  placeholder="First name"
                  autoComplete="off"
                  value={draftFor(drafts, v).first}
                  onChange={(e) => editName(v, { first: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Last name"
                  autoComplete="off"
                  value={draftFor(drafts, v).last}
                  onChange={(e) => editName(v, { last: e.target.value })}
                />
                {/* Enabled only when something has actually changed, so the row
                    does not offer a save that would do nothing. */}
                <button type="submit" disabled={busy === v.email || !isDirty(drafts, v)}>
                  Save
                </button>
              </form>

              <div className="admin-row-actions">
                {v.role !== 'viewer' && (
                  <button
                    disabled={busy === v.email || v.bootstrap}
                    title={v.bootstrap ? BOOTSTRAP_REASON : undefined}
                    onClick={() => void mutate({ email: v.email, role: 'viewer' }, v.email)}
                  >
                    Make viewer
                  </button>
                )}
                {v.role !== 'owner' && (
                  <button
                    disabled={busy === v.email}
                    onClick={() => void mutate({ email: v.email, role: 'owner' }, v.email)}
                  >
                    Make owner
                  </button>
                )}
                {v.role !== 'pending' && (
                  <button
                    disabled={busy === v.email}
                    onClick={() =>
                      mutate(
                        { email: v.email, emailPref: v.email_pref === 'daily' ? 'none' : 'daily' },
                        v.email,
                      )
                    }
                  >
                    {v.email_pref === 'daily' ? 'Stop emails' : 'Send emails'}
                  </button>
                )}
                {v.email !== me.email && (
                  <button
                    className="admin-danger"
                    disabled={busy === v.email || v.bootstrap}
                    title={v.bootstrap ? BOOTSTRAP_REASON : undefined}
                    onClick={() => void mutate({ email: v.email, remove: true }, v.email)}
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
