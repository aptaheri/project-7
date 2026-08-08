import { createHmac, timingSafeEqual } from 'node:crypto'

export type Role = 'owner' | 'viewer' | 'pending'

/**
 * The cookie carries identity only — never the role. Roles are read from the
 * database on every request so that revoking access takes effect immediately
 * rather than whenever a 30-day cookie happens to expire.
 */
export interface Session {
  email: string
  /** Unix seconds. */
  exp: number
}

export const SESSION_COOKIE = 'p7_session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value) throw new Error('SESSION_SECRET is not set')
  return value
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function createSession(email: string): { value: string; session: Session } {
  const session: Session = {
    email,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  }
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
  return { value: `${payload}.${sign(payload)}`, session }
}

export function readSession(value: string | null): Session | null {
  if (!value) return null

  const dot = value.lastIndexOf('.')
  if (dot < 1) return null

  const payload = value.slice(0, dot)
  const provided = Buffer.from(value.slice(dot + 1), 'utf8')
  const expected = Buffer.from(sign(payload), 'utf8')

  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session
    if (typeof session.exp !== 'number' || session.exp < Math.floor(Date.now() / 1000)) return null
    if (typeof session.email !== 'string' || session.email.length === 0) return null
    return session
  } catch {
    return null
  }
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/** Secure is dropped over plain http so `netlify dev` on localhost still works. */
export function sessionCookie(req: Request, value: string, maxAge = MAX_AGE_SECONDS): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export function clearedCookie(req: Request): string {
  return sessionCookie(req, '', 0)
}

/** Reads and validates the session on an incoming request. */
export function currentSession(req: Request): Session | null {
  return readSession(getCookie(req, SESSION_COOKIE))
}
