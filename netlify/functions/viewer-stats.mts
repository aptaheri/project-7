import { json } from '../lib/auth.mts'
import { requireOwner } from '../lib/gate.mts'
import { joinedAt, normalizeEmail } from '../lib/users.mts'
import { visitHistory } from '../lib/visits.mts'

/**
 * One viewer's recent opens of the tracker, for the sharing page's detail
 * view. Owner-only, same as the list it is reached from.
 *
 *   GET /api/viewer-stats?email=X&days=N (days defaults to 14, capped at 90)
 */

const DEFAULT_DAYS = 14
const MAX_DAYS = 90

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405)

  const owner = await requireOwner(req)
  if (owner instanceof Response) return owner

  const url = new URL(req.url)
  const email = url.searchParams.get('email')
  if (!email || !email.includes('@')) return json({ error: 'a valid email is required' }, 400)

  const requested = Number(url.searchParams.get('days') ?? DEFAULT_DAYS)
  const days = Number.isFinite(requested) ? Math.min(MAX_DAYS, Math.max(1, requested)) : DEFAULT_DAYS

  try {
    const address = normalizeEmail(email)
    const [history, joined] = await Promise.all([visitHistory(address, days), joinedAt(address)])
    const totalVisits = history.reduce((sum, d) => sum + d.visits, 0)
    const lastSeen = history[0]?.date ?? null

    return json({ email: address, totalVisits, lastSeen, joinedAt: joined, days: history })
  } catch (error) {
    console.error('viewer stats request failed', error)
    return json({ error: 'request failed' }, 500)
  }
}
