import { json } from '../lib/auth.mts'
import { currentSession } from '../lib/session.mts'
import { canViewTrack, isEmailPref, normalizeEmail, setEmailPref } from '../lib/users.mts'
import { db, ensureSchema } from '../lib/db.mts'
import type { Role } from '../lib/session.mts'

/**
 * A signed-in person changing their own email preference.
 *
 * Separate from /api/viewers, which is owner-only: most people who get the
 * daily email are viewers and will never see the sharing page, so without this
 * the unsubscribe page's promise that they can turn the emails back on would
 * be false. It reads the address from the session and ignores any address in
 * the body, so it cannot be used to unsubscribe somebody else.
 */
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const session = currentSession(req)
  if (!session) return json({ error: 'not signed in' }, 401)

  try {
    let body: { pref?: unknown }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return json({ error: 'invalid json' }, 400)
    }

    if (!isEmailPref(body.pref)) {
      return json({ error: "pref must be 'daily' or 'none'" }, 400)
    }

    const email = normalizeEmail(session.email)
    await ensureSchema()
    const rows = (await db()`
      select role from viewers where email = ${email}
    `) as unknown as { role: Role }[]

    // Someone still pending has nothing to subscribe to yet.
    if (!rows[0] || !canViewTrack(rows[0].role)) return json({ error: 'forbidden' }, 403)

    await setEmailPref(email, body.pref)
    return json({ ok: true, emailPref: body.pref })
  } catch (error) {
    console.error('email preference change failed', error)
    return json({ error: 'request failed' }, 500)
  }
}
