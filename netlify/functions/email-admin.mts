import { json } from '../lib/auth.mts'
import { runDailyEmail } from '../lib/daily.mts'
import { currentSession } from '../lib/session.mts'
import { db, ensureSchema } from '../lib/db.mts'
import { normalizeEmail } from '../lib/users.mts'

/**
 * Owner-only window onto the daily email: what it would decide right now, what
 * it would look like, and a way to post one copy to yourself.
 *
 * Separate from the scheduled function because Netlify does not expose a
 * scheduled function over HTTP. Both call the same runDailyEmail, so what is
 * previewed here is what goes out.
 */
export default async function handler(req: Request): Promise<Response> {
  const session = currentSession(req)
  if (!session) return json({ error: 'not signed in' }, 401)

  await ensureSchema()
  const rows = (await db()`
    select role from viewers where email = ${normalizeEmail(session.email)}
  `) as unknown as { role: string }[]
  if (rows[0]?.role !== 'owner') return json({ error: 'owners only' }, 403)

  const url = new URL(req.url)
  const format = url.searchParams.get('format')
  const force = url.searchParams.get('force') === '1'
  // A test send goes to the signed-in owner, never to an address off the query
  // string — otherwise this endpoint is a way to mail strangers from our domain.
  const test = url.searchParams.get('send') === 'me'

  const outcome = await runDailyEmail({
    dryRun: !test,
    force,
    onlyTo: test ? normalizeEmail(session.email) : undefined,
  })

  if (format === 'html' && outcome.preview) {
    return new Response(outcome.preview.html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  return json({ ...outcome, preview: outcome.preview ? { subject: outcome.preview.subject } : undefined })
}
