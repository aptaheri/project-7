import { warmOnce } from '../lib/warm.mts'

/**
 * The scheduled half: one run, every three hours, and nothing else.
 *
 * The run itself lives in lib/warm.mts so that an owner can ask for one on
 * demand through fact-admin — Netlify answers 403 to an HTTP request for a
 * scheduled function, so this file's own URL is not a way to trigger it.
 */
export default async function handler(): Promise<Response> {
  try {
    await warmOnce()
    return new Response(null, { status: 204 })
  } catch {
    return new Response(null, { status: 500 })
  }
}

// Every three hours. Frequent enough that a reroute is covered long before the
// morning it matters, rare enough that a caught-up day costs eight handfuls of
// indexed reads. Offset from the hour so it is never queued behind the email.
//
// Typed loosely because the site does not depend on @netlify/functions —
// Netlify reads this shape either way.
export const config = {
  schedule: '20 */3 * * *',
}
