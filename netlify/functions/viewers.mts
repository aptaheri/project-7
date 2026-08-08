import { json } from '../lib/auth.mts'
import { currentSession } from '../lib/session.mts'
import { isRole, listViewers, removeViewer, setRole } from '../lib/users.mts'
import { db, ensureSchema } from '../lib/db.mts'
import type { Role } from '../lib/session.mts'

/**
 * Owner-only management of who can see the tracker.
 *
 *   GET  /api/viewers → list everyone who has signed in, with their role
 *   POST /api/viewers → { email, role } to grant, or { email, remove: true }
 */

async function requireOwner(req: Request): Promise<{ email: string } | Response> {
  const session = currentSession(req)
  if (!session) return json({ error: 'unauthorized' }, 401)

  await ensureSchema()
  const sql = db()
  const rows = (await sql`select role from viewers where email = ${session.email}`) as unknown as {
    role: Role
  }[]

  if (rows[0]?.role !== 'owner') return json({ error: 'forbidden' }, 403)
  return { email: session.email }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const owner = await requireOwner(req)
    if (owner instanceof Response) return owner

    if (req.method === 'GET') {
      return json({ viewers: await listViewers() })
    }

    if (req.method === 'POST') {
      let body: { email?: unknown; role?: unknown; remove?: unknown }
      try {
        body = (await req.json()) as typeof body
      } catch {
        return json({ error: 'invalid json' }, 400)
      }

      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (!email.includes('@')) return json({ error: 'a valid email is required' }, 400)

      if (body.remove === true) {
        // Losing the last owner would leave nobody able to grant access.
        if (email === owner.email) return json({ error: 'you cannot remove yourself' }, 400)
        await removeViewer(email)
        return json({ ok: true })
      }

      if (!isRole(body.role)) return json({ error: 'role must be owner, viewer or pending' }, 400)
      if (email === owner.email && body.role !== 'owner') {
        return json({ error: 'you cannot demote yourself' }, 400)
      }

      await setRole(email, body.role, owner.email)
      return json({ ok: true })
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (error) {
    console.error('viewers request failed', error)
    return json({ error: 'request failed' }, 500)
  }
}
