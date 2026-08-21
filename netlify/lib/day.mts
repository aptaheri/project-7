/**
 * The rider's local day, expressed as a range of instants.
 *
 * Everything in the tracker is bucketed by his local date, and the obvious way
 * to write that in SQL — `(tst at time zone $zone)::date = $today` — wraps the
 * column in a function call. A btree index on tst cannot answer that, so every
 * query "for today" read the entire table and threw almost all of it away. The
 * cost of showing today's ride therefore grew with every day he had ever
 * ridden.
 *
 * Converting the day to a half-open range of timestamps first, `tst >= $start
 * and tst < $end`, is the same question asked in a form the index can answer.
 */

/**
 * How far the given zone is ahead of UTC at that instant, in milliseconds.
 *
 * Derived by formatting the instant in the zone and reading the wall clock
 * back, which is the only way to get this without shipping a timezone database
 * of our own — and tz-lookup, which we already depend on, gives names rather
 * than offsets.
 */
function offsetMs(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // Intl formats midnight as hour 24 rather than 0 in this configuration.
  const hour = field('hour') % 24

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  )
  return asUtc - at.getTime()
}

/**
 * The instant local midnight falls at, for a YYYY-MM-DD in a zone.
 *
 * Applied twice because the offset depends on the instant we are trying to
 * find: on the night the clocks change, the offset an hour before midnight is
 * not the offset at midnight, and a single pass lands an hour out. The second
 * pass is measured at the answer the first pass gave, which is correct
 * everywhere except inside the skipped hour itself — where local midnight does
 * not exist at all, and any answer is a convention.
 */
export function localMidnightUtc(zone: string, date: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`)
  const first = new Date(naive - offsetMs(zone, new Date(naive)))
  return new Date(naive - offsetMs(zone, first))
}

/** The half-open range [start, end) of instants making up one local day. */
export function localDayRange(zone: string, date: string): { start: Date; end: Date } {
  const start = localMidnightUtc(zone, date)
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
  const nextDate = next.toISOString().slice(0, 10)
  return { start, end: localMidnightUtc(zone, nextDate) }
}
