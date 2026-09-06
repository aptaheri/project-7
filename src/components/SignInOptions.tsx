import { useEffect, useState } from 'react'
import GoogleSignIn from './GoogleSignIn'
import {
  completeMagicLink,
  completeMicrosoftSignIn,
  requestMagicLink,
  startMicrosoftSignIn,
} from '../lib/auth'
import type { Me } from '../lib/auth'

/**
 * The three ways in, all offered rather than chosen for them.
 *
 * Picking on their behalf was the original plan — look the domain up and route
 * them. It does not survive contact with the addresses actually on this list:
 * Cornell's mail is Microsoft's and its people sign in with Google, Mayo runs
 * its own servers, and Harvard, Stanford and JPMorgan sit behind gateways that
 * say nothing at all about who authenticates them. Three buttons are always
 * right, because the person knows.
 */

interface Props {
  clientId: string | null
  microsoftClientId: string | null
  onSignedIn: (me: Me) => void
}

type Pending = null | 'microsoft' | 'link'

export default function SignInOptions({ clientId, microsoftClientId, onSignedIn }: Props) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)

  // Both round trips come back to this page carrying something in the URL — a
  // Microsoft code, or a token from a link in somebody's inbox. Spend it before
  // anything else renders, so a refresh cannot replay it.
  useEffect(() => {
    let cancelled = false
    async function finish() {
      try {
        const link = await completeMagicLink()
        if (link && !cancelled) {
          onSignedIn(link)
          return
        }
        const ms = await completeMicrosoftSignIn()
        if (!ms || cancelled) return
        if (ms.me) onSignedIn(ms.me)
        else if (ms.confirming) setConfirming(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'That did not work.')
      }
    }
    void finish()
    return () => {
      cancelled = true
    }
    // Once, on mount. The URL is consumed and cleaned inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function onMicrosoft() {
    if (!microsoftClientId) return
    setError(null)
    setPending('microsoft')
    try {
      await startMicrosoftSignIn(microsoftClientId)
    } catch (e) {
      setPending(null)
      setError(e instanceof Error ? e.message : 'Could not reach Microsoft.')
    }
  }

  async function onLink(event: React.FormEvent) {
    event.preventDefault()
    const address = email.trim()
    if (!address.includes('@')) {
      setError('That does not look like an email address.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await requestMagicLink(address)
      setSentTo(address)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the link.')
    } finally {
      setBusy(false)
    }
  }

  if (confirming) {
    return (
      <p className="track-panel-note signin-sent">
        Almost there — check your email. Microsoft does not tell us whether an
        address really belongs to an account, so we confirm it once. You will
        not be asked again.
      </p>
    )
  }

  if (sentTo) {
    return (
      <p className="track-panel-note signin-sent">
        If <strong>{sentTo}</strong> can be signed in, a link is on its way. It
        works once and lasts fifteen minutes.
      </p>
    )
  }

  return (
    <div className="signin">
      <GoogleSignIn clientId={clientId} onSignedIn={onSignedIn} />

      {microsoftClientId && (
        <button type="button" className="signin-microsoft" onClick={() => void onMicrosoft()} disabled={pending !== null}>
          {/* Microsoft's mark is four squares; drawn rather than fetched so the
              button does not wait on a third-party image to appear. */}
          <span className="signin-ms-mark" aria-hidden="true">
            <i style={{ background: '#f25022' }} />
            <i style={{ background: '#7fba00' }} />
            <i style={{ background: '#00a4ef' }} />
            <i style={{ background: '#ffb900' }} />
          </span>
          {pending === 'microsoft' ? 'Taking you to Microsoft…' : 'Sign in with Microsoft'}
        </button>
      )}

      <div className="signin-or"><span>or</span></div>

      <form className="signin-link" onSubmit={(e) => void onLink(e)}>
        <label className="signin-label" htmlFor="signin-email">
          Email me a link instead
        </label>
        <div className="signin-row">
          <input
            id="signin-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </form>

      {error && <p className="track-panel-note track-panel-error">{error}</p>}
    </div>
  )
}
