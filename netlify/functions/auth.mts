import { createRemoteJWKSet, jwtVerify } from 'jose'
import { json } from '../lib/auth.mts'
import { clearedCookie, createSession, currentSession, sessionCookie } from '../lib/session.mts'
import { canViewTrack, cleanName, normalizeEmail, ownerEmails, recordSignIn } from '../lib/users.mts'
import { buildAccessRequestEmail } from '../lib/access-email.mts'
import { buildMagicEmail } from '../lib/magic-email.mts'
import { bindIdentity, boundEmail, rememberProvider } from '../lib/identity.mts'
import type { Provider } from '../lib/identity.mts'
import { MAGIC_TTL_MINUTES, issueLink, redeemLink } from '../lib/magic.mts'
import { mailerConfigured, sendBatch } from '../lib/mailer.mts'

/**
 * Google sign-in. Actions are resolved from the request path, with ?action=
 * as a fallback (see the handler for why).
 *
 *   GET  /api/auth/me      → who am I, plus the client id for the sign-in button
 *   POST /api/auth/google  → exchange a Google ID token for a session cookie
 *   POST /api/auth/logout  → drop the session
 */

const ACTIONS = ['me', 'google', 'microsoft', 'magic', 'verify', 'logout']

/**
 * Microsoft's keys, and the issuer pattern its tokens carry.
 *
 * The `common` endpoint serves every tenant, so the issuer is per-tenant and
 * cannot be pinned to one string — it is checked against the shape instead, and
 * the tenant it names is checked against the `tid` claim so a token cannot
 * claim one tenant in its issuer and another in its body.
 */
const MICROSOFT_JWKS = createRemoteJWKSet(
  new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'),
)
const MICROSOFT_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/

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


/**
 * Issues the session, once an address has actually been proved.
 *
 * Everything that gets this far has established the address some way the app is
 * willing to stand behind — a Google token with `email_verified`, a magic link
 * that was delivered and clicked, or a Microsoft identity already bound by one
 * of those. Never a bare claim.
 */
async function signIn(
  req: Request,
  provider: Provider,
  email: string,
  subject: string,
  firstName: string | null,
  lastName: string | null,
): Promise<Response> {
  const { role, emailPref, newRequest } = await recordSignIn(email, { firstName, lastName })
  await bindIdentity({ provider, subject, email, firstName, lastName })
  await rememberProvider(email, provider)

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
}

/**
 * Sends a one-time link, and says the same thing whether or not anybody by that
 * name is known.
 *
 * An endpoint that only mails addresses it recognises is an endpoint that tells
 * the internet which of John's friends are on the list, one guess at a time.
 */
async function sendLink(
  req: Request,
  email: string,
  confirming: 'microsoft' | null,
): Promise<Response> {
  const origin = process.env.URL ?? new URL(req.url).origin ?? SITE
  try {
    if (!mailerConfigured()) {
      console.error(`no link sent to ${email}: RESEND_API_KEY is not set`)
      return json({ sent: true })
    }
    const { token } = await issueLink(email)
    const url = `${origin}/track?token=${encodeURIComponent(token)}`
    const { subject, html, text } = buildMagicEmail({
      url,
      minutes: MAGIC_TTL_MINUTES,
      confirming,
    })
    const result = await sendBatch([{ to: email, subject, html, text }])
    if (result.failed.length > 0) console.error(`link to ${email} failed: ${result.failed[0].error}`)
  } catch (error) {
    // Logged, never surfaced: the reply is identical either way, and the
    // difference between "we could not send" and "there is nobody there" is
    // exactly what must not leak.
    console.error('sign-in link failed', error)
  }
  return json({ sent: true })
}

export default async function handler(req: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? null
  const microsoftClientId = process.env.MICROSOFT_CLIENT_ID ?? null

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
    if (!session) return json({ authenticated: false, clientId, microsoftClientId })
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
        microsoftClientId,
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

  // ── Microsoft ───────────────────────────────────────────────────────────
  // The token is verified properly and then, on its own, grants nothing.
  // Microsoft issues no email_verified claim and this app accepts tokens from
  // any tenant — it has to, since every university is its own — so an address
  // in one of its tokens is a claim. The first time an identity makes that
  // claim it is checked by post; after that the binding is what signs it in.
  if (action === 'microsoft' && req.method === 'POST') {
    const microsoftClientId = process.env.MICROSOFT_CLIENT_ID
    if (!microsoftClientId) {
      console.error('MICROSOFT_CLIENT_ID is not configured')
      return json({ error: 'Microsoft sign-in is not configured' }, 500)
    }

    let idToken: unknown
    try {
      idToken = ((await req.json()) as { idToken?: unknown }).idToken
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (typeof idToken !== 'string' || !idToken) {
      return json({ error: 'missing token' }, 400)
    }

    let subject: string
    let claimed: string
    let firstName: string | null = null
    let lastName: string | null = null
    try {
      const { payload } = await jwtVerify(idToken, MICROSOFT_JWKS, {
        audience: microsoftClientId,
      })

      // The issuer names a tenant. It must be well formed, and it must be the
      // same tenant the body claims — otherwise a token could be signed for one
      // directory and presented as another's.
      const issuer = typeof payload.iss === 'string' ? MICROSOFT_ISSUER.exec(payload.iss) : null
      const tid = typeof payload.tid === 'string' ? payload.tid : null
      if (!issuer || !tid || issuer[1] !== tid) {
        return json({ error: 'unrecognised issuer' }, 401)
      }

      // oid is stable for a person within a tenant; tid says which directory.
      // Together they are the thing that does not change when somebody renames
      // themselves or their organisation moves their mail.
      const oid = typeof payload.oid === 'string' ? payload.oid : null
      if (!oid) return json({ error: 'token carries no subject' }, 401)
      subject = `${tid}:${oid}`

      const address =
        (typeof payload.email === 'string' && payload.email) ||
        (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
        null
      if (!address || !address.includes('@')) {
        return json({ error: 'token carries no email address' }, 403)
      }
      claimed = normalizeEmail(address)

      const display = cleanName(payload.name)
      if (display) {
        const parts = display.split(/\s+/)
        firstName = parts[0] ?? null
        lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
      }
    } catch (error) {
      console.error('microsoft token verification failed', error)
      return json({ error: 'invalid token' }, 401)
    }

    try {
      const bound = await boundEmail('microsoft', subject)
      if (bound) {
        // Signed in as the address this identity has proved it owns, which is
        // deliberately not whatever the token says today.
        return await signIn(req, 'microsoft', bound, subject, firstName, lastName)
      }
      // First time. The claim gets checked once, by post.
      console.log(`microsoft identity ${subject} claims ${claimed}; confirming by email`)
      return await sendLink(req, claimed, 'microsoft')
    } catch (error) {
      console.error('microsoft sign-in failed', error)
      return json({ error: 'sign-in failed' }, 500)
    }
  }

  // ── A link in the post ──────────────────────────────────────────────────
  if (action === 'magic' && req.method === 'POST') {
    let address: unknown
    try {
      address = ((await req.json()) as { email?: unknown }).email
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (typeof address !== 'string' || !address.includes('@') || address.length > 254) {
      return json({ error: 'that does not look like an email address' }, 400)
    }
    return await sendLink(req, normalizeEmail(address), null)
  }

  // ── Spending the link ───────────────────────────────────────────────────
  // Clicking it is possession of the address, which is the strongest proof of
  // the three and the only one that needs nothing taken on trust.
  if (action === 'verify' && req.method === 'POST') {
    let token: unknown
    try {
      token = ((await req.json()) as { token?: unknown }).token
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (typeof token !== 'string' || !token) return json({ error: 'missing token' }, 400)

    try {
      const result = await redeemLink(token)
      if (!result.ok) {
        const said = {
          used: 'That link has already been used. Ask for a new one.',
          expired: `That link has expired — they last ${MAGIC_TTL_MINUTES} minutes. Ask for a new one.`,
          unknown: 'That link is not one of ours. Ask for a new one.',
        }
        return json({ error: said[result.reason] }, 401)
      }
      // The address is the subject: for this provider they are the same thing,
      // because the address is exactly what was proved.
      return await signIn(req, 'email', result.email, result.email, null, null)
    } catch (error) {
      console.error('link redemption failed', error)
      return json({ error: 'sign-in failed' }, 500)
    }
  }

  return json({ error: 'not found' }, 404)
}
