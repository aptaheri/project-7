import tzLookup from 'tz-lookup'
import itinerary from '../../src/data/itinerary.json'
import { db, ensureSchema } from './db.mts'
import { localDayRange } from './day.mts'
import { currentLeg } from './itinerary.mts'
import { loadRoute } from './route.mts'
import { GAP_M } from './rollups.mts'
import { ownerEmails } from './users.mts'
import { mailerConfigured, sendBatch } from './mailer.mts'
import { buildSafetyEmail } from './safety-email.mts'
import type { SafetyEmailInput } from './safety-email.mts'

/**
 * A quiet word to the owners when a riding day stops looking like one.
 *
 * Asked for after John was hit by a car outside Kipchak — he was fine, and the
 * only way anybody heard was a text the next morning. Two shapes of trouble are
 * visible from here:
 *
 * - **quiet**: he had set off, and then the fixes stopped, with him well short
 *   of the night's town.
 * - **still**: the fixes keep arriving, but he has not moved for a long time,
 *   again well short of the town.
 *
 * Neither is proof of anything. Through Central Asia the commonest cause of
 * "quiet" is no signal — OwnTracks keeps recording and sends the lot when it
 * reconnects — and the commonest cause of "still" is lunch. So the email says
 * what was seen and what it usually means, goes to owners only, says so once
 * per episode, and says so again when he turns up.
 *
 * Every threshold is a SAFETY_* setting rather than a constant, because nobody
 * knows the right numbers yet and the first week of these will be the evidence.
 * Netlify bakes settings in at deploy time, so changing one is a redeploy from
 * the dashboard — not a code change.
 */

const SITE = 'https://project7.bike'

function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

export function safetySettings() {
  return {
    /** No fix for this long, mid-ride, is "quiet". */
    quietMinutes: setting('SAFETY_QUIET_MINUTES', 60, 15, 600),
    /** Still reporting but within `stillRadiusM` for this long is "still". Lunch is often an hour. */
    stillMinutes: setting('SAFETY_STILL_MINUTES', 120, 30, 600),
    stillRadiusM: setting('SAFETY_STILL_RADIUS_M', 300, 50, 5000),
    /** Within this straight-line distance of the night's town, he has arrived. */
    nearKm: setting('SAFETY_NEAR_KM', 5, 0.5, 50),
    /** He has set off once he has covered this much today. */
    setOffKm: setting('SAFETY_SET_OFF_KM', 3, 0.5, 50),
    /** His local hours in which a riding day is watched at all. */
    fromHour: setting('SAFETY_FROM_HOUR', 7, 0, 23),
    untilHour: setting('SAFETY_UNTIL_HOUR', 20, 0, 23),
    /** Alerts of all kinds in one of his days, so a bad-signal day cannot become a flood. */
    maxPerDay: setting('SAFETY_MAX_PER_DAY', 3, 1, 20),
  }
}

/** A fix newer than this counts as "he is reporting right now". */
const FRESH_MINUTES = 20

/** Moving this far from where an alert was raised counts as moving again. */
const MOVED_AGAIN_M = 1000

/** Hours of slack when guessing his local time from the plan, as the email does. */
const GUESS_SLACK_HOURS = 2

export type AlertKind = 'quiet' | 'still'

export interface SafetyOutcome {
  /** What happened, for a log line or the owner's dry run. */
  action: 'skipped' | 'nothing' | 'alerted' | 'cleared'
  reason: string
  kind?: AlertKind
  localDate?: string
  localTime?: string
  /** What the check saw, so the thresholds can be tuned from evidence. */
  observed?: {
    lastFixMinutesAgo: number
    riddenTodayKm: number
    destination: string | null
    toDestinationKm: number | null
    stillForMinutes: number | null
    battery: number | null
    connection: string | null
  }
  recipients?: string[]
  subject?: string
  preview?: { subject: string; html: string; text: string }
}

export interface SafetyOptions {
  /** Decide and render, but neither send nor record. */
  dryRun?: boolean
  /** The instant to judge at. Real time unless a test says otherwise. */
  now?: Date
  origin?: string
}

function testDevices(): string[] {
  return (process.env.TRACK_TEST_DEVICES ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
}

function clock(zone: string, at: Date): { date: string; hour: number; time: string } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(at)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at)
  return { date, hour: Number(time.slice(0, 2)) % 24, time }
}

function zoneAt(lat: number, lon: number): string {
  try {
    return tzLookup(lat, lon)
  } catch {
    return 'UTC'
  }
}

/**
 * His local hour from the plan, without the database — the same trick the
 * morning email uses. Most runs happen while he is asleep, and waking a
 * database that bills by the hour to learn that is most of what a check like
 * this would otherwise cost. Null when the plan says nothing about today.
 */
function plannedLocalHour(now: Date): number | null {
  const utcDate = now.toISOString().slice(0, 10)
  const planned = (itinerary.days as { date: string; toCoords?: [number, number] | null; fromCoords?: [number, number] | null }[])
    .find((d) => d.date === utcDate)
  const coords = planned?.toCoords ?? planned?.fromCoords
  if (!coords) return null
  return clock(zoneAt(coords[1], coords[0]), now).hour
}

function metres(a: [number, number], b: [number, number]): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const h =
    Math.sin(rad(b[1] - a[1]) / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

interface OpenAlert {
  id: number
  kind: AlertKind
  resolved: boolean
  lat: number
  lon: number
  last_fix: string
}

export async function runSafetyCheck(options: SafetyOptions = {}): Promise<SafetyOutcome> {
  const { dryRun = false, origin = SITE } = options
  const now = options.now ?? new Date()
  const s = safetySettings()

  if (process.env.SAFETY_PAUSED) {
    return { action: 'skipped', reason: 'SAFETY_PAUSED is set' }
  }

  // Night where he is, judged from the plan: stop before touching anything.
  const guess = plannedLocalHour(now)
  if (guess !== null && (guess < s.fromHour - GUESS_SLACK_HOURS || guess > s.untilHour + GUESS_SLACK_HOURS)) {
    return { action: 'skipped', reason: `roughly ${guess}:00 along the plan, outside riding hours` }
  }

  await ensureSchema()
  const sql = db()
  const devices = testDevices()
  const at = now.toISOString()

  const latestRows = (await sql`
    select tst::text as tst, lat, lon, batt, conn
    from locations
    where (device = any(${devices}::text[])) = false
      and source = 'device'
      and tst <= ${at}::timestamptz
    order by tst desc
    limit 1
  `) as unknown as { tst: string; lat: number; lon: number; batt: number | null; conn: string | null }[]

  const latest = latestRows[0]
  if (!latest) return { action: 'skipped', reason: 'no fixes recorded yet' }

  const position: [number, number] = [latest.lon, latest.lat]
  const zone = zoneAt(latest.lat, latest.lon)
  const { date: today, hour, time } = clock(zone, now)
  const base = { localDate: today, localTime: time }

  if (hour < s.fromHour || hour > s.untilHour) {
    return { ...base, action: 'skipped', reason: `${time} where he is, outside riding hours` }
  }

  const lastFixAt = new Date(latest.tst)
  const quietMinutes = (now.getTime() - lastFixAt.getTime()) / 60_000

  // Today, as a range the index can answer (rule 3), and only up to now.
  const { start } = localDayRange(zone, today)
  const todayRows = (await sql`
    with ordered as (
      select
        tst, lat, lon,
        lag(lat) over (order by tst) as plat,
        lag(lon) over (order by tst) as plon
      from locations
      where (device = any(${devices}::text[])) = false
        and source = 'device'
        and tst >= ${start.toISOString()}::timestamptz
        and tst <= ${at}::timestamptz
    ),
    steps as (
      select tst,
        case when plat is null then 0 else
          2 * 6371000 * asin(least(1, sqrt(
            power(sin(radians(lat - plat) / 2), 2) +
            cos(radians(plat)) * cos(radians(lat)) *
            power(sin(radians(lon - plon) / 2), 2)
          )))
        end as step_m
      from ordered
    )
    select
      coalesce(sum(case when step_m > ${GAP_M}::float8 then 0 else step_m end), 0)::float8 as ridden_m,
      min(tst)::text as first_fix
    from steps
  `) as unknown as { ridden_m: number; first_fix: string | null }[]
  const riddenKm = (todayRows[0]?.ridden_m ?? 0) / 1000

  // The town he is riding to tonight, from the route as it now stands.
  const leg = currentLeg(position, today, await loadRoute())
  const riding = leg?.kind === 'ride'
  const toDestinationKm = riding ? leg.distanceToDestinationKm : null

  // How long he has been within a few hundred metres of where he is now, read
  // back from the fixes of the last few hours. Only asked while he is still
  // reporting: a phone that has gone quiet is the other question.
  let stillForMinutes: number | null = null
  if (quietMinutes <= FRESH_MINUTES) {
    const lookback = new Date(now.getTime() - (s.stillMinutes + 60) * 60_000)
    const since = lookback > start ? lookback : start
    const recent = (await sql`
      select tst::text as tst, lat, lon
      from locations
      where (device = any(${devices}::text[])) = false
        and source = 'device'
        and tst >= ${since.toISOString()}::timestamptz
        and tst <= ${at}::timestamptz
      order by tst desc
    `) as unknown as { tst: string; lat: number; lon: number }[]
    // Walk back until a fix lies outside the radius; everything before that
    // point he has been standing within it.
    let stillSince = lastFixAt
    for (const fix of recent) {
      if (metres(position, [fix.lon, fix.lat]) > s.stillRadiusM) break
      stillSince = new Date(fix.tst)
    }
    stillForMinutes = (now.getTime() - stillSince.getTime()) / 60_000
  }

  const observed = {
    lastFixMinutesAgo: Math.round(quietMinutes),
    riddenTodayKm: Math.round(riddenKm * 10) / 10,
    destination: riding ? leg.to : null,
    toDestinationKm: toDestinationKm === null ? null : Math.round(toDestinationKm * 10) / 10,
    stillForMinutes: stillForMinutes === null ? null : Math.round(stillForMinutes),
    battery: latest.batt,
    connection: latest.conn,
  }

  const alerts = (await sql`
    select id, kind, resolved_at is not null as resolved, lat, lon, last_fix::text as last_fix
    from safety_alerts where local_date = ${today}::date
    order by sent_at
  `) as unknown as OpenAlert[]
  const open = alerts.filter((a) => !a.resolved)

  // ── An alert already out: say so when he turns up ─────────────────────────
  // Checked before anything else, so an all-clear goes even once he has reached
  // the town, or the clock has moved past riding hours on the next run.
  for (const alert of open) {
    const back =
      alert.kind === 'quiet'
        ? quietMinutes <= FRESH_MINUTES
        : metres([alert.lon, alert.lat], position) > MOVED_AGAIN_M ||
          (toDestinationKm !== null && toDestinationKm <= s.nearKm)
    if (!back) continue

    // Fixes from inside the gap that arrived late mean the phone was recording
    // all along and simply had no signal.
    let rodeDuringGap: number | null = null
    if (alert.kind === 'quiet') {
      const gap = (await sql`
        with ordered as (
          select lat, lon,
            lag(lat) over (order by tst) as plat, lag(lon) over (order by tst) as plon
          from locations
          where (device = any(${devices}::text[])) = false
            and source = 'device'
            and tst >= ${alert.last_fix}::timestamptz
            and tst <= ${at}::timestamptz
        )
        select coalesce(sum(case when plat is null then 0 else
          2 * 6371000 * asin(least(1, sqrt(
            power(sin(radians(lat - plat) / 2), 2) +
            cos(radians(plat)) * cos(radians(lat)) *
            power(sin(radians(lon - plon) / 2), 2)
          ))) end), 0)::float8 as m
        from ordered
      `) as unknown as { m: number }[]
      rodeDuringGap = (gap[0]?.m ?? 0) / 1000
    }

    const input: SafetyEmailInput = {
      kind: alert.kind,
      clearing: true,
      localTime: time,
      lastFix: clock(zone, lastFixAt).time,
      minutes: alert.kind === 'quiet' ? quietMinutes : stillForMinutes ?? 0,
      riddenKm,
      destination: riding ? leg.to : null,
      toDestinationKm,
      position,
      battery: latest.batt,
      connection: latest.conn,
      rodeDuringGapKm: rodeDuringGap,
      settings: s,
      origin,
    }
    return await deliver('cleared', alert, input, { ...base, observed }, dryRun, today)
  }

  // ── Nothing out yet: is there anything to raise? ──────────────────────────
  if (!riding) {
    return { ...base, observed, action: 'nothing', reason: leg ? `a ${leg.kind} day` : 'no riding leg matches where he is' }
  }
  if (riddenKm < s.setOffKm) {
    return { ...base, observed, action: 'nothing', reason: `has not set off — ${riddenKm.toFixed(1)} km today` }
  }
  if (toDestinationKm !== null && toDestinationKm <= s.nearKm) {
    return { ...base, observed, action: 'nothing', reason: `within ${s.nearKm} km of ${leg.to}` }
  }

  const kind: AlertKind | null =
    quietMinutes >= s.quietMinutes
      ? 'quiet'
      : stillForMinutes !== null && stillForMinutes >= s.stillMinutes
        ? 'still'
        : null
  if (!kind) {
    return { ...base, observed, action: 'nothing', reason: 'moving, or not long enough to worry' }
  }
  // Said once per episode. The all-clear above is what reopens it.
  if (open.some((a) => a.kind === kind)) {
    return { ...base, observed, kind, action: 'nothing', reason: `${kind} alert already sent, waiting for him to turn up` }
  }
  if (alerts.length >= s.maxPerDay) {
    return { ...base, observed, kind, action: 'nothing', reason: `already ${alerts.length} alert(s) today, the most allowed` }
  }

  const input: SafetyEmailInput = {
    kind,
    clearing: false,
    localTime: time,
    lastFix: clock(zone, lastFixAt).time,
    minutes: kind === 'quiet' ? quietMinutes : stillForMinutes ?? 0,
    riddenKm,
    destination: leg.to,
    toDestinationKm,
    position,
    battery: latest.batt,
    connection: latest.conn,
    rodeDuringGapKm: null,
    settings: s,
    origin,
  }
  return await deliver('alerted', null, input, { ...base, observed, kind }, dryRun, today, lastFixAt)
}

/**
 * Records, then sends — the order the morning email uses, for the same reason:
 * a send that half fails must not be retried into a second copy every fifteen
 * minutes. An alert is claimed in the table before it goes, and cleared in the
 * table before the all-clear goes.
 */
async function deliver(
  action: 'alerted' | 'cleared',
  alert: OpenAlert | null,
  input: SafetyEmailInput,
  context: Partial<SafetyOutcome>,
  dryRun: boolean,
  today: string,
  lastFixAt?: Date,
): Promise<SafetyOutcome> {
  const email = buildSafetyEmail(input)
  const reason =
    action === 'cleared'
      ? `${input.kind} alert cleared`
      : input.kind === 'quiet'
        ? `no fix for ${Math.round(input.minutes)} min`
        : `within ${input.settings.stillRadiusM} m for ${Math.round(input.minutes)} min`

  if (dryRun) {
    return { ...context, action, kind: input.kind, reason: `dry run — would send: ${reason}`, subject: email.subject, preview: email }
  }

  const sql = db()
  if (action === 'alerted') {
    await sql`
      insert into safety_alerts (local_date, kind, lat, lon, last_fix, detail)
      values (${today}::date, ${input.kind}, ${input.position[1]}, ${input.position[0]},
              ${(lastFixAt ?? new Date()).toISOString()}::timestamptz, ${reason})
    `
  } else if (alert) {
    await sql`update safety_alerts set resolved_at = now() where id = ${alert.id}`
  }

  const owners = await ownerEmails()
  if (!mailerConfigured() || owners.length === 0) {
    return { ...context, action, kind: input.kind, reason: `${reason}, but nobody to tell — no mailer or no owners`, subject: email.subject }
  }
  const result = await sendBatch(owners.map((to) => ({ to, ...email })))
  if (result.failed.length) console.error('safety: some alerts failed to send', result.failed)
  return { ...context, action, kind: input.kind, reason, subject: email.subject, recipients: owners }
}
