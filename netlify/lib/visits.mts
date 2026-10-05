import { db, ensureSchema } from './db.mts'
import { normalizeEmail } from './users.mts'

/**
 * How often the tracker gets opened, per person.
 *
 * Counted from track-history.mts rather than the live feed: history is
 * fetched once a session and again only when something changed, while the
 * feed polls every 30 seconds for as long as the map stays open. Counting
 * there would make the number "how long did they leave the tab open" rather
 * than "how often did they come back" — and would scale the write with the
 * same cost rule 2 exists to keep flat.
 */

export interface VisitSummary {
  totalVisits: number
  lastSeen: string | null
}

export interface VisitDay {
  date: string
  visits: number
}

/** Records one open of the tracker for today, in UTC. */
export async function recordVisit(email: string): Promise<void> {
  await ensureSchema()
  await db()`
    insert into track_visits (email, local_date, visits, last_seen)
    values (${normalizeEmail(email)}, (now() at time zone 'utc')::date, 1, now())
    on conflict (email, local_date) do update
      set visits = track_visits.visits + 1, last_seen = now()
  `
}

/** Every viewer's all-time total and most recent open, keyed by email. */
export async function visitSummaries(): Promise<Map<string, VisitSummary>> {
  await ensureSchema()
  const rows = (await db()`
    select email, sum(visits)::int as total_visits, max(last_seen) as last_seen
    from track_visits
    group by email
  `) as unknown as { email: string; total_visits: number; last_seen: string }[]

  return new Map(rows.map((r) => [r.email, { totalVisits: r.total_visits, lastSeen: r.last_seen }]))
}

/** One person's opens for each of the last `days` days, newest first. */
export async function visitHistory(email: string, days: number): Promise<VisitDay[]> {
  await ensureSchema()
  const rows = (await db()`
    select local_date::text as date, visits
    from track_visits
    where email = ${normalizeEmail(email)}
      and local_date >= (current_date - ${days}::int)
    order by local_date desc
  `) as unknown as VisitDay[]
  return rows
}
