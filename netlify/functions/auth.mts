import { createRemoteJWKSet, jwtVerify } from 'jose'
import { json } from '../lib/auth.mts'
import { clearedCookie, createSession, currentSession, sessionCookie } from '../lib/session.mts'
import { canViewTrack, cleanName, normalizeEmail, ownerEmails, recordSignIn } from '../lib/users.mts'
import { buildAccessRequestEmail } from '../lib/access-email.mts'
import { mailerConfigured, sendBatch } from '../lib/mailer.mts'

/**
 * Google sign-in. Actions are resolved from the request path, with ?action=
 * as a fallback (see the handler for why).
 *
 *   GET  /api/auth/me      → who am I, plus the client id for the sign-in button
 *   POST /api/auth/google  → exchange a Google ID token for a session cookie
 *   POST /api/auth/logout  → drop the session
 */

const ACTIONS = ['me', 'google', 'logout']

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const SITE = 'https://project7.bike'

/**
 * Tells every owner that somebody has asked for access.
 *
 * Deliberately swallows its own failures. A rejected send, a missing API key, a
 * Resend outage — none of those are reasons to fail the sign-in of the person
 * who just asked, and the request is recorded in the database either way, which
 * is where the sharing page reads it from. So the worst case is a missed
 * notification rather than a visitor who cannot get in, and the pending row is
 * still waiting on the page when an owner next looks.
 *
 * Awaited rather than fired and forgotten, because a serverless function is
 * frozen the moment it responds and an unawaited send would be cancelled about
 * as often as it completed.
 */
async function notifyOwners(name: string | null, email: string, origin: string): Promise<void> {
  try {
    if (!mailerConfigured()) {
      console.warn(`access request from ${email} not emailed: RESEND_API_KEY is not set`)
      return
    }

    const owners = await ownerEmails()
    if (owners.length === 0) {
      console.warn(`access request from ${email} not emailed: no owners on file`)
      return
    }

    const { subject, html, text } = buildAccessRequestEmail({ name, email, origin })
    // No unsubscribe link: this is administration of the site, not a list to
    // leave, and the only token we have would drop them from the daily email.
    const result = await sendBatch(owners.map((to) => ({ to, subject, html, text })))
    console.log(
      `access request from ${email} emailed to ${result.sent} owner(s)` +
        (result.failed.length ? `, ${result.failed.length} failed` : ''),
    )
  } catch (error) {
    console.error('access request notification failed', error)
  }
}

export default async function handler(req: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? null

  // The action can arrive two ways depending on how Netlify presents a
  // rewritten request: as the last path segment of the original URL
  // (/api/auth/me) or as the ?action= set by the redirect destination. Accept
  // either rather than depending on which one the platform surfaces.
  const url = new URL(req.url)
  const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? ''
  const action = ACTIONS.includes(lastSegment)
    ? lastSegment
    : (url.searchParams.get('action') ?? '')

  if (!ACTIONS.includes(action)) {
    console.error(`unknown auth action; pathname=${url.pathname} search=${url.search}`)
    return json({ error: 'not found' }, 404)
  }

  if (action === 'me' && req.method === 'GET') {
    const session = currentSession(req)
    if (!session) return json({ authenticated: false, clientId })
    try {
      // recordSignIn rather than a plain lookup, so adding someone to
      // TRACK_OWNER_EMAILS promotes them on their next poll instead of
      // requiring them to sign out and back in.
      const { role, emailPref } = await recordSignIn(session.email)
      return json({
        authenticated: true,
        email: session.email,
        role,
        emailPref,
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
    let firstName: string | null = null
    let lastName: string | null = null
    try {
      const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
      })
      // An unverified address could be attacker-controlled, so it never counts.
      if (payload.email_verified !== true || typeof payload.email !== 'string') {
        return json({ error: 'email not verified with Google' }, 403)
      }
      email = normalizeEmail(payload.email)
      // The token already carries who they are, so nobody is asked to type a
      // name into a form to get access. Taken only from a token that has just
      // been verified against Google's keys — the same standard as the address.
      // `name` is the fallback for accounts that carry only a display name: its
      // first word is a better guess at a first name than nothing at all.
      firstName = cleanName(payload.given_name)
      lastName = cleanName(payload.family_name)
      if (!firstName && !lastName) {
        const display = cleanName(payload.name)
        if (display) {
          const parts = display.split(/\s+/)
          firstName = parts[0] ?? null
          lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
        }
      }
    } catch (error) {
      console.error('google token verification failed', error)
      return json({ error: 'invalid credential' }, 401)
    }

    try {
      const { role, emailPref, newRequest } = await recordSignIn(email, { firstName, lastName })

      // Only on the sign-in that created the request. /api/auth/me also records
      // a sign-in, and mailing the owners every time a signed-in browser polls
      // it would be absurd; a repeat sign-in inserts nothing, so it stays quiet
      // too. The one case that mails twice is somebody who is removed and then
      // signs in again, which is a second request and worth knowing about.
      if (newRequest) {
        const origin = process.env.URL ?? new URL(req.url).origin ?? SITE
        await notifyOwners([firstName, lastName].filter(Boolean).join(' ') || null, email, origin)
      }

      const { value } = createSession(email)
      return new Response(
        JSON.stringify({ authenticated: true, email, role, emailPref, canView: canViewTrack(role) }),
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
