import itinerary from '../../src/data/itinerary.json'
import { ensureFact } from '../lib/fact.mts'
import type { Warmed } from '../lib/fact.mts'

/**
 * Writes the destination lines ahead of the emails that use them.
 *
 * Generating one takes about thirteen seconds and sometimes twenty, because the
 * model searches the web before it will commit to a sentence. That is fine on
 * its own schedule and impossible during a send: the daily email has around
 * thirty seconds to read the day's riding, render, and hand forty messages to
 * Resend, and an anecdote is the least important thing in that budget.
 *
 * So the work happens here, hours early, and the send does a lookup. This is
 * still generated rather than hand-written — nobody is curating a list — it
 * just happens before the morning rather than during it.
 *
 * Once a place has a line it is never written again, so a caught-up run costs
 * a few indexed reads and nothing else. Only genuinely new destinations — a
 * reroute, the next country — cost anything.
 */

/** How far ahead to look. Comfortably more than the gap between runs. */
const LOOKAHEAD_DAYS = 4

/**
 * How many lines one run may write.
 *
 * Measured: a search plus an answer runs from thirteen to twenty-two seconds,
 * inside a function that has about thirty. That is room for exactly one. A
 * second would be killed partway and its work thrown away, so the rest wait for
 * the next run three hours later — and with roughly one new destination a day
 * against eight runs, waiting costs nothing.
 */
const WRITES_PER_RUN = 1

interface Day {
  date: string
  to: string | null
}

/** Destinations for today and the next few days, in order, without repeats. */
function upcoming(today: string): string[] {
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + LOOKAHEAD_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const seen = new Set<string>()
  for (const day of itinerary.days as Day[]) {
    if (day.date < today || day.date > last) continue
    if (day.to) seen.add(day.to)
  }
  return [...seen]
}

export default async function handler(): Promise<Response> {
  // The server's date, not the rider's. A day either side of his does no harm
  // when the window is four days wide, and it saves waking the database to ask
  // where he is.
  const today = new Date().toISOString().slice(0, 10)
  const started = Date.now()
  const counts: Record<Warmed, number> = {
    curated: 0, stored: 0, written: 0, declined: 0, failed: 0, skipped: 0,
  }

  try {
    for (const destination of upcoming(today)) {
      // Reads are cheap and tell us whether there is anything to do; writing is
      // the part that is rationed.
      const outcome = await ensureFact(destination, counts.written < WRITES_PER_RUN)
      counts[outcome] += 1
      if (outcome === 'written' && counts.written >= WRITES_PER_RUN) {
        console.log('fact-warm: wrote one, the rest waits for the next run')
        break
      }
    }

    console.log(`fact-warm: ${JSON.stringify(counts)} in ${Math.round((Date.now() - started) / 1000)}s`)
    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('fact-warm failed:', error)
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
