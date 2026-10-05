import { json } from './auth.mts'
import { db, ensureSchema } from './db.mts'
import { currentSession } from './session.mts'
import { canViewTrack, normalizeEmail } from './users.mts'
import type { Role } from './session.mts'

/**
 * The sign-in wall in front of the tracker, in one place.
 *
 * Two endpoints serve the live map now, and a gate copied into both is a gate
 * that will eventually be tightened in one and not the other.
 *
 * The role is read fresh on every request rather than trusted from the cookie,
 * so revoking someone takes effect on their next poll rather than whenever a
 * thirty-day session happens to expire.
 */
export async function requireTrackViewer(
  req: Request,
): Promise<{ role: Role; email: string } | Response> {
  const session = currentSession(req)
  if (!session) return json({ error: 'unauthorized' }, 401)

  try {
    await ensureSchema()
    const rows = (await db()`
      select role from viewers where email = ${normalizeEmail(session.email)}
    `) as unknown as { role: Role }[]
    const role = rows[0]?.role ?? 'pending'
    if (!canViewTrack(role)) return json({ error: 'forbidden' }, 403)
    return { role, email: normalizeEmail(session.email) }
  } catch (error) {
    console.error('role check failed', error)
    return json({ error: 'query failed' }, 500)
  }
}

/** The same wall, for the admin surfaces behind the sharing page. */
export async function requireOwner(req: Request): Promise<{ email: string } | Response> {
  const session = currentSession(req)
  if (!session) return json({ error: 'unauthorized' }, 401)

  await ensureSchema()
  const rows = (await db()`
    select role from viewers where email = ${normalizeEmail(session.email)}
  `) as unknown as { role: Role }[]

  if (rows[0]?.role !== 'owner') return json({ error: 'forbidden' }, 403)
  return { email: normalizeEmail(session.email) }
}
