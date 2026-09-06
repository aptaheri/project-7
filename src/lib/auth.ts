import { useEffect, useReducer } from 'react'

export type Role = 'owner' | 'viewer' | 'pending'

export type EmailPref = 'daily' | 'none'

export interface Me {
  authenticated: boolean
  email?: string
  role?: Role
  /** Whether they get the daily email. Absent until they have signed in. */
  emailPref?: EmailPref
  canView?: boolean
  clientId: string | null
  /** Null until MICROSOFT_CLIENT_ID is set, which hides the button. */
  microsoftClientId?: string | null
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: {
            client_id: string
            callback: (response: { credential: string }) => void
          }): void
          renderButton(element: HTMLElement, options: Record<string, unknown>): void
        }
      }
    }
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client'

/** Loads Google Identity Services once and resolves when it is ready. */
export function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google script failed to load')))
      return
    }
    const script = document.createElement('script')
    script.src = GSI_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google script failed to load'))
    document.head.appendChild(script)
  })
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch('/api/auth/me')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Me
}

export async function signInWithGoogle(credential: string): Promise<Me> {
  const res = await fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  const body = (await res.json()) as Me & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}


// ── Microsoft, by hand ──────────────────────────────────────────────────────
// Authorization code with PKCE, written out rather than pulled in: all this
// needs is an ID token, and @azure/msal-browser is a large dependency for one
// redirect and one token exchange. The app is registered as a single-page
// application, so there is no client secret to hold — PKCE is what stands in
// for one, and a secret could not be kept in a browser anyway.

const MS_AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const MS_VERIFIER_KEY = 'p7_ms_verifier'
const MS_STATE_KEY = 'p7_ms_state'

function randomUrlSafe(bytes = 32): string {
  const raw = new Uint8Array(bytes)
  crypto.getRandomValues(raw)
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Where Microsoft sends them back. Registered in Entra, so it must match exactly. */
function msRedirectUri(): string {
  return `${window.location.origin}/track`
}

/** Sends them to Microsoft. Returns only if something stopped it. */
export async function startMicrosoftSignIn(clientId: string): Promise<void> {
  const verifier = randomUrlSafe()
  const state = randomUrlSafe(16)
  // Session storage rather than local: this is a secret with a one-minute life
  // and no business outliving the tab it was created in.
  sessionStorage.setItem(MS_VERIFIER_KEY, verifier)
  sessionStorage.setItem(MS_STATE_KEY, state)

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: msRedirectUri(),
    // openid and email are all this needs. Asking for more would put a consent
    // screen full of permissions in front of somebody who wants to see a map.
    scope: 'openid email profile',
    state,
    code_challenge: verifier ? await challengeFor(verifier) : '',
    code_challenge_method: 'S256',
  })
  window.location.assign(`${MS_AUTHORITY}/authorize?${params.toString()}`)
}

export interface MicrosoftReturn {
  /** Signed in. */
  me?: Me
  /** Their address is being confirmed by post, because Microsoft does not. */
  confirming?: string
}

/**
 * Finishes the round trip, if this page load is one.
 *
 * Returns null when the URL carries no code, which is almost every page load.
 */
export async function completeMicrosoftSignIn(): Promise<MicrosoftReturn | null> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const failed = url.searchParams.get('error')

  if (!code && !failed) return null

  const verifier = sessionStorage.getItem(MS_VERIFIER_KEY)
  const expected = sessionStorage.getItem(MS_STATE_KEY)
  sessionStorage.removeItem(MS_VERIFIER_KEY)
  sessionStorage.removeItem(MS_STATE_KEY)

  // Clean the URL either way, so a refresh does not replay a spent code.
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  url.searchParams.delete('error')
  url.searchParams.delete('error_description')
  url.searchParams.delete('session_state')
  window.history.replaceState({}, '', url.toString())

  if (failed) throw new Error(url.searchParams.get('error_description') ?? 'Microsoft sign-in was cancelled.')
  if (!verifier || !expected) throw new Error('That sign-in did not start here. Try again.')
  if (returnedState !== expected) throw new Error('That sign-in did not start here. Try again.')

  const me = await fetchMe()
  if (!me.microsoftClientId) throw new Error('Microsoft sign-in is not configured.')

  // Exchanged in the browser because the app is a public client: there is no
  // secret, and PKCE is what proves this is the same session that started it.
  const exchange = await fetch(`${MS_AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: me.microsoftClientId,
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: msRedirectUri(),
      code_verifier: verifier,
    }),
  })
  const tokens = (await exchange.json()) as { id_token?: string; error_description?: string }
  if (!exchange.ok || !tokens.id_token) {
    throw new Error(tokens.error_description ?? 'Microsoft did not return a token.')
  }

  const res = await fetch('/api/auth/microsoft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: tokens.id_token }),
  })
  const body = (await res.json()) as Me & { error?: string; sent?: boolean }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  // A first-time identity is not signed in — it is being confirmed by post.
  if (body.sent) return { confirming: 'microsoft' }
  return { me: body }
}

// ── A link in the post ──────────────────────────────────────────────────────

export async function requestMagicLink(email: string): Promise<void> {
  const res = await fetch('/api/auth/magic', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = (await res.json()) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
}

/** Spends a ?token= in the URL, if this page load carries one. */
export async function completeMagicLink(): Promise<Me | null> {
  const url = new URL(window.location.href)
  const token = url.searchParams.get('token')
  if (!token) return null

  url.searchParams.delete('token')
  window.history.replaceState({}, '', url.toString())

  const res = await fetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const body = (await res.json()) as Me & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
}

export interface AuthState {
  me: Me | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  setMe: (me: Me) => void
}

/**
 * One shared auth state for the whole app.
 *
 * Both the navbar and the tracker need to know who is signed in. A per-hook
 * useState would mean two requests on /track and a navbar that stays stale
 * after sign-in, so the state lives here and every hook subscribes to it.
 */
let state: { me: Me | null; loading: boolean; error: string | null } = {
  me: null,
  loading: true,
  error: null,
}
const listeners = new Set<() => void>()
let started = false

function emit() {
  for (const listener of listeners) listener()
}

export function refreshMe(): Promise<void> {
  state = { ...state, loading: true }
  emit()
  return fetchMe()
    .then((me) => {
      state = { me, loading: false, error: null }
    })
    .catch((err: Error) => {
      state = { me: null, loading: false, error: err.message }
    })
    .finally(emit)
}

function setMe(me: Me) {
  state = { me, loading: false, error: null }
  emit()
}

export function useAuth(): AuthState {
  const [, bump] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    listeners.add(bump)
    if (!started) {
      started = true
      void refreshMe()
    }
    return () => {
      listeners.delete(bump)
    }
  }, [])

  return { ...state, refresh: refreshMe, setMe }
}
