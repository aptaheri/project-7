import { db, ensureSchema } from '../lib/db.mts'
import { DRAWN_DAYS, loadRoute, warmGeometry } from '../lib/route.mts'

/**
 * Fetches the roads the live map draws ahead of him.
 *
 * The map shows every night left in the trip. A day John has edited was routed
 * when he saved it, but the rest are two towns and nothing between, and a
 * straight line from Trieste to Dalmatia goes through sixty miles of Adriatic —
 * which is why nothing is drawn for a day until its road is known.
 *
 * On its own clock rather than folded into fact-warm, and that is not tidiness:
 * that function spends up to twenty-five seconds on one model call, and a
 * scheduled function has about thirty. Adding a second's directions to the end
 * of it, eight times, is how a run gets killed halfway and loses the fact it
 * had already paid for.
 */

/**
 * Roads per run.
 *
 * A directions call is about a second, so twenty leaves a third of the budget
 * spare. Nothing here is urgent — the map simply draws less until it catches
 * up — so the ceiling is set for safety rather than speed.
 */
const PER_RUN = 20

export default async function handler(): Promise<Response> {
  const started = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const last = new Date(Date.parse(`${today}T00:00:00Z`) + DRAWN_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)

  try {
    await ensureSchema()

    // Days already known, either because he edited one and it was routed then,
    // or because a previous run fetched it.
    const cached = ((await db()`
      select to_char(date, 'YYYY-MM-DD') as date from route_geometry
      where date >= ${today}::date and date <= ${last}::date
    `) as unknown as { date: string }[]).map((r) => r.date)
    const known = new Set(cached)

    const needing = (await loadRoute()).filter(
      (d) =>
        d.date >= today && d.date <= last &&
        d.kind !== 'rest' && d.fromCoords && d.toCoords &&
        !d.routeCoords && !known.has(d.date),
    )

    let done = 0
    let failed = 0
    for (const day of needing.slice(0, PER_RUN)) {
      // Stop short rather than be killed: a run that ends on its own terms has
      // written everything it fetched, and the next one carries on from there.
      if (Date.now() - started > 22_000) break
      if (await warmGeometry(day)) done += 1
      else failed += 1
    }

    console.log(
      `route-warm: ${done} road(s), ${failed} refused, ${needing.length - done} still to do,` +
        ` in ${Math.round((Date.now() - started) / 1000)}s`,
    )
    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('route-warm failed:', error)
    return new Response(null, { status: 500 })
  }
}

// Every twenty minutes while there is a backlog, which there is once — a few
// hundred days at twenty a run clears inside a day. After that almost every run
// finds nothing to do and costs one query, because the only days that appear
// are the ones John has just rerouted.
export const config = {
  schedule: '*/20 * * * *',
}
