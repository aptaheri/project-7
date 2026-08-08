import { createRemoteJWKSet, jwtVerify } from 'jose'
import { json } from '../lib/auth.mts'
import { clearedCookie, createSession, currentSession, sessionCookie } from '../lib/session.mts'
import { canViewTrack, recordSignIn } from '../lib/users.mts'
import { db, ensureSchema } from '../lib/db.mts'
import type { Role } from '../lib/session.mts'

/**
 * Google sign-in. Actions arrive as ?action=… from the /api/auth/:action
 * rewrite in public/_redirects.
 *
 *   GET  /api/auth/me      → who am I, plus the client id for the sign-in button
 *   POST /api/auth/google  → exchange a Google ID token for a session cookie
 *   POST /api/auth/logout  → drop the session
 */

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

async function roleFor(email: string): Promise<Role> {
  await ensureSchema()
  const sql = db()
  const rows = (await sql`select role from viewers where email = ${email.toLowerCase()}`) as unknown as {
    role: Role
  }[]
  return rows[0]?.role ?? 'pending'
}

export default async function handler(req: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? null
  const action = new URL(req.url).searchParams.get('action')

  if (action === 'me' && req.method === 'GET') {
    const session = currentSession(req)
    if (!session) return json({ authenticated: false, clientId })
    try {
      const role = await roleFor(session.email)
      return json({
        authenticated: true,
        email: session.email,
        role,
        canView: canViewTrack(role),
        clientId,
      })
    } catch (error) {
      console.error('role lookup failed', error)
      return json({ error: 'lookup failed' }, 500)
    }
  }

  if (action === 'logout' && req.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': clearedCookie(req),
      },
    })
  }

  if (action === 'google' && req.method === 'POST') {
    if (!clientId) {
      console.error('GOOGLE_CLIENT_ID is not configured')
      return json({ error: 'sign-in is not configured' }, 500)
    }

    let credential: unknown
    try {
      credential = ((await req.json()) as { credential?: unknown }).credential
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (typeof credential !== 'string' || !credential) {
      return json({ error: 'missing credential' }, 400)
    }

    let email: string
    try {
      const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
      })
      // An unverified address could be attacker-controlled, so it never counts.
      if (payload.email_verified !== true || typeof payload.email !== 'string') {
        return json({ error: 'email not verified with Google' }, 403)
      }
      email = payload.email.toLowerCase()
    } catch (error) {
      console.error('google token verification failed', error)
      return json({ error: 'invalid credential' }, 401)
    }

    try {
      const role = await recordSignIn(email)
      const { value } = createSession(email)
      return new Response(
        JSON.stringify({ authenticated: true, email, role, canView: canViewTrack(role) }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'set-cookie': sessionCookie(req, value),
          },
        },
      )
    } catch (error) {
      console.error('sign-in failed', error)
      return json({ error: 'sign-in failed' }, 500)
    }
  }

  return json({ error: 'not found' }, 404)
}
