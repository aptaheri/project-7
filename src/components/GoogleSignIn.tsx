import { useEffect, useRef, useState } from 'react'
import { loadGoogleScript, signInWithGoogle } from '../lib/auth'
import type { Me } from '../lib/auth'

interface Props {
  clientId: string | null
  onSignedIn: (me: Me) => void
}

export default function GoogleSignIn({ clientId, onSignedIn }: Props) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  // Kept in a ref so the effect below does not re-run when the parent
  // re-renders with a new callback identity, which would render the button twice.
  const onSignedInRef = useRef(onSignedIn)
  useEffect(() => {
    onSignedInRef.current = onSignedIn
  }, [onSignedIn])

  useEffect(() => {
    if (!clientId || !buttonRef.current) return
    let cancelled = false

    loadGoogleScript()
      .then(() => {
        if (cancelled || !buttonRef.current || !window.google) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: ({ credential }) => {
            signInWithGoogle(credential)
              .then((me) => onSignedInRef.current(me))
              .catch((err: Error) => setError(err.message))
          },
        })
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text: 'signin_with',
        })
      })
      .catch((err: Error) => setError(err.message))

    return () => {
      cancelled = true
    }
  }, [clientId])

  if (!clientId) {
    return <p className="track-panel-note">Google sign-in is not configured yet.</p>
  }

  return (
    <>
      <div ref={buttonRef} className="google-signin" />
      {error && <p className="track-panel-note track-panel-error">{error}</p>}
    </>
  )
}
