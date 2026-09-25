import { ensureFact } from './fact.mts'
import { loadRoute } from './route.mts'
import type { Warmed } from './fact.mts'

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
 * How many times one run may call the model — successes and failures alike.
 *
 * Measured: a search plus an answer runs from fifteen to over twenty-five
 * seconds, inside a function that has about thirty. That is room for exactly
 * one attempt. Counting only successes would be the trap: two places that each
 * time out at twenty-five seconds would take fifty, and the run would be killed
 * partway with nothing to show for it.
 *
 * So a run makes one attempt and stops. With roughly one new destination a day
 * against eight runs, that is ample.
 */
export const ATTEMPTS_PER_RUN = 1

/**
 * Destinations for today and the next few days, with the distance he rides to
 * reach each — the distance sentence is written about that number, so it has to
 * come from the same row as the destination.
 *
 * A place reached more than once keeps its riding day's mileage rather than a
 * rest day's absence of one.
 */
async function upcoming(
  today: string,
): Promise<{ to: string; date: string; miles: number | null; from: string | null; note: string | null }[]> {
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + LOOKAHEAD_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const byDestination = new Map<
    string,
    { date: string; miles: number | null; from: string | null; note: string | null }
  >()
  // The route as it now stands, so a destination he entered last night is
  // warmed tonight rather than whenever somebody edits a file.
  for (const day of await loadRoute()) {
    if (day.date < today || day.date > last) continue
    if (!day.to) continue
    const known = byDestination.get(day.to)
    // First occurrence wins, so a place he reaches on a riding day keeps that
    // day's distance rather than the rest day that follows it.
    if (!byDestination.has(day.to) || (known && known.miles === null && day.kind === 'ride')) {
      byDestination.set(day.to, {
        date: day.date,
        miles: day.kind === 'ride' ? day.miles : null,
        // Where he sets off from and whatever the route says about the day —
        // "Klausen Pass", "Alps". The only advance signal there is for whether
        // today is a climbing day.
        from: day.from,
        note: day.note || null,
      })
    }
  }
  return [...byDestination].map(([to, at]) => ({
    to, date: at.date, miles: at.miles, from: at.from, note: at.note,
  }))
}

/**
 * One warming run: at most `budget` model calls, nearest day first.
 *
 * Lifted out of the scheduled function so an owner can ask for a run without
 * waiting three hours for the next one. Netlify answers 403 to an HTTP request
 * for a scheduled function, so the cron's own URL is not a way to test it —
 * which is how a deploy that rewrote every destination line could not be seen
 * until the following morning.
 *
 * `budget` stays at one for the cron: the run has thirty seconds and a single
 * question can take twenty-five, so two of them would lose the whole run. A
 * caller that knows it has longer may ask for more.
 */
export async function warmOnce(budget = ATTEMPTS_PER_RUN): Promise<{
  counts: Record<Warmed, number>
  seconds: number
  spentOn: string[]
}> {
  // The server's date, not the rider's. A day either side of his does no harm
  // when the window is four days wide, and it saves waking the database to ask
  // where he is.
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const started = Date.now()
  const counts: Record<Warmed, number> = {
    curated: 0, stored: 0, written: 0, declined: 0, failed: 0, skipped: 0, exhausted: 0,
  }
  const spentOn: string[] = []

  try {
    // Today and tomorrow first, always. Those are the destinations an email is
    // about to be written about, and a reroute entered at nine in the evening
    // has only three runs before the morning send — spending them on a village
    // four days out would be the wrong choice every time.
    //
    // The rest rotate by the hour, so a place that keeps timing out cannot sit
    // at the front taking every run's single attempt and starving the days
    // behind it. Tence has already proved it can do that. Floored, because the
    // cron fires on multiples of three but a manual run at 14:00 would
    // otherwise index the queue with 4.666 and read undefined.
    const all = await upcoming(today)
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10)
    const soon = all.filter((d) => d.date <= tomorrow)
    const later = all.filter((d) => d.date > tomorrow)
    const start = later.length ? Math.floor(now.getUTCHours() / 3) % later.length : 0
    const queue = [...soon, ...later.map((_, i) => later[(start + i) % later.length])]

    let attempts = 0
    outer: for (let i = 0; i < queue.length; i++) {
      const { to, miles, from, note } = queue[i]
      // A place takes more than one question to finish — the paragraph, then
      // the present — so finish the one nearest his arrival before moving on.
      // Visiting each place once instead spreads a budget of three across three
      // days and completes none of them, which is what a warm=3 did on the day
      // this shipped: three histories rewritten, not one town finished.
      //
      // Bounded by the budget and by the queue, and `stored` or `exhausted`
      // ends it, so a place that keeps timing out cannot hold the loop.
      for (;;) {
        // Reads are cheap and tell us whether there is anything to do; calling
        // the model is the part that is rationed.
        const outcome = await ensureFact(to, miles, attempts < budget, { from, note })
        counts[outcome] += 1
        if (outcome !== 'written' && outcome !== 'declined' && outcome !== 'failed') break
        attempts += 1
        spentOn.push(`${to} (${outcome})`)
        if (attempts >= budget) {
          console.log(`fact-warm: attempts spent on ${spentOn.join(', ')}, the rest waits`)
          break outer
        }
        // A question that failed or was refused does not get asked again in the
        // same run: the next one is the next place's turn, and ensureFact has
        // already recorded the attempt.
        if (outcome !== 'written') break
      }
    }

    const seconds = Math.round((Date.now() - started) / 1000)
    console.log(`fact-warm: ${JSON.stringify(counts)} in ${seconds}s`)
    return { counts, seconds, spentOn }
  } catch (error) {
    console.error('fact-warm failed:', error)
    throw error
  }
}

