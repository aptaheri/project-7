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
