import { useCallback, useEffect, useState } from 'react'

export type Role = 'owner' | 'viewer' | 'pending'

export interface Me {
  authenticated: boolean
  email?: string
  role?: Role
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
  refresh: () => void
  setMe: (me: Me) => void
}

export function useAuth(): AuthState {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    fetchMe()
      .then((next) => {
        setMe(next)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(refresh, [refresh])

  return { me, loading, error, refresh, setMe }
}
