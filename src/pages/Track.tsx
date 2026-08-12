import { useCallback } from 'react'
import GoogleSignIn from '../components/GoogleSignIn'
import TrackMap from './TrackMap'
import { signOut, useAuth } from '../lib/auth'
import './Track.scss'

/**
 * Auth gate for the live tracker. The map is only mounted once the signed-in
 * account holds the owner or viewer role, so an unapproved visitor never even
 * loads Mapbox.
 */
export default function Track() {
  const { me, loading, error, refresh, setMe } = useAuth()

  const handleSignOut = useCallback(() => {
    signOut().finally(refresh)
  }, [refresh])

  if (loading) {
    return (
      <div className="track track-gate">
        <div className="track-card">
          <p className="track-panel-title">Loading…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="track track-gate">
        <div className="track-card">
          <p className="track-panel-title">Something went wrong</p>
          <p className="track-panel-note">{error}</p>
          <button className="track-recenter" onClick={refresh}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (!me?.authenticated) {
    return (
      <div className="track track-gate">
        <div className="track-card">
          <p className="track-overline">Project 7</p>
          <h1>Live tracking</h1>
          <p className="track-panel-note">
            Sign in to continue. Access is granted per account — if yours is new,
            an owner has to approve it before the map appears.
          </p>
          <GoogleSignIn clientId={me?.clientId ?? null} onSignedIn={setMe} />
        </div>
      </div>
    )
  }

  if (!me.canView) {
    return (
      <div className="track track-gate">
        <div className="track-card">
          <p className="track-overline">Project 7</p>
          <h1>Awaiting approval</h1>
          <p className="track-panel-note">
            You are signed in as <strong>{me.email}</strong>, but an owner has
            not granted access yet. Your request has been recorded.
          </p>
          <div className="track-card-actions">
            <button className="track-recenter" onClick={refresh}>
              Check again
            </button>
            <button className="track-signout" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  return <TrackMap emailPref={me.emailPref ?? 'daily'} />
}
