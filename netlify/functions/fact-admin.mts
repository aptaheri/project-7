import { json } from '../lib/auth.mts'
import { db, ensureSchema } from '../lib/db.mts'
import { currentSession } from '../lib/session.mts'
import { normalizeEmail } from '../lib/users.mts'
import { factFor } from '../lib/fact.mts'
import { warmOnce } from '../lib/warm.mts'

/**
 * Warming a destination line on an owner's say-so, rather than on the clock.
 *
 * `fact-warm` runs every three hours and Netlify answers 403 to an HTTP request
 * for a scheduled function, so there was no way to make one happen. That is
 * fine until the brief changes: raising FORMAT_VERSION marks every stored line
 * out of date, and the only thing that rewrites them is the cron — so a deploy
 * that changed what every morning says could not be looked at until the next
 * one fired, and `email-admin` kept rendering the old text because it reads the
 * cache and never writes to it.
 *
 * ?warm=1   one question, the same as a cron run
 * ?warm=3   up to three, for catching a place up after a brief change
 * ?place=X  what is stored for one destination, without warming anything
 *
 * The budget is capped because each question can take twenty-five seconds and
 * this function has the same ten-second head start as any other — four would
 * risk the request timing out halfway through, which costs the money without
 * recording the answer.
 */
const MAX_BUDGET = 3

export default async function handler(req: Request): Promise<Response> {
  const session = currentSession(req)
  if (!session) return json({ error: 'not signed in' }, 401)

  await ensureSchema()
  const rows = (await db()`
    select role from viewers where email = ${normalizeEmail(session.email)}
  `) as unknown as { role: string }[]
  if (rows[0]?.role !== 'owner') return json({ error: 'owners only' }, 403)

  const url = new URL(req.url)

  // A read, so an owner can see what tomorrow will actually say before
  // spending anything on rewriting it.
  const place = url.searchParams.get('place')
  if (place) return json({ place, lines: await factFor(place) })

  const asked = Number(url.searchParams.get('warm') ?? '1')
  const budget = Math.min(Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 1, MAX_BUDGET)

  try {
    const result = await warmOnce(budget)
    return json({ budget, ...result })
  } catch (error) {
    console.error('fact-admin failed:', error)
    return json({ error: 'warming failed — see the function log' }, 500)
  }
}
