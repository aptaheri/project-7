import tzLookup from 'tz-lookup'
import itinerary from '../../src/data/itinerary.json'
import { db, ensureSchema } from './db.mts'
import { buildDailyEmail } from './email.mts'
import { currentLeg } from './itinerary.mts'
import { mailerConfigured, sendBatch, unsubscribeUrl } from './mailer.mts'
import type { OutgoingEmail } from './mailer.mts'

/**
 * Decides whether this is a morning to write to people, and writes if so.
 *
 * The bar is deliberately high. An email that lands when John is asleep, or
 * pointing at a live map with nothing moving on it, teaches people to ignore
 * the next one — and there are three hundred more of those to come. Every gate
 * below exists to make the mail worth opening rather than merely regular.
 */

const SITE = 'https://project7.bike'

/**
 * Earliest and latest hour, rider-local, at which a morning email may go out.
 *
 * Overridable by environment so the window can be shifted without a deploy —
 * the right hour is a judgement about when people read mail, not a constant,
 * and it may want changing once there is evidence about when they open it.
 */
function sendWindow(): { from: number; until: number } {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name])
    return Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback
  }
  return { from: read('EMAIL_SEND_FROM_HOUR', 6), until: read('EMAIL_SEND_UNTIL_HOUR', 11) }
}

/** He counts as out on the road once he has covered this much today. */
const MIN_MOVING_KM = 3

/**
 * How recent his last fix must be.
 *
 * The whole promise of the email is "click and watch him move". A fix from two
 * hours ago means the phone is in a pannier with no signal, and the map would
 * open on a stationary dot.
 */
const MAX_FIX_AGE_MINUTES = 45

const KM_PER_MILE = 1.609344

interface DayRecord {
  day: number
  date: string
  kind: string
  from: string | null
  to: string | null
  miles: number | null
  fromCoords: [number, number] | null
  toCoords: [number, number] | null
}

export interface DailyOutcome {
  /** True when mail was actually handed to Resend. */
  sent: boolean
  /** Why nothing was sent, in words meant for a log line. */
  reason: string
  localDate?: string
  localHour?: number
  timezone?: string
  subject?: string
  recipients?: string[]
  failed?: { to: string; error: string }[]
  /** Resend ids, so a send can be looked up on their Emails page. */
  messageIds?: string[]
  /** Set on a dry run so the message can be looked at without sending it. */
  preview?: { subject: string; html: string; text: string }
}

export interface DailyOptions {
  /** Work out everything, render the mail, then stop short of sending. */
  dryRun?: boolean
  /** Ignore the clock, the movement gate and the already-sent record. */
  force?: boolean
  /** Send to this one address instead of the subscriber list. */
  onlyTo?: string
  origin?: string
}

function dayRecords(): DayRecord[] {
  return itinerary.days as DayRecord[]
}

function localNow(lat: number, lon: number): { zone: string; date: string; hour: number } {
  let zone: string
  try {
    zone = tzLookup(lat, lon)
  } catch {
    zone = 'UTC'
  }
  const now = new Date()
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now)
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      hour12: false,
    }).format(now),
  )
  return { zone, date, hour }
}

function testDevices(): string[] {
  return (process.env.TRACK_TEST_DEVICES ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
}

export async function runDailyEmail(options: DailyOptions = {}): Promise<DailyOutcome> {
  const { dryRun = false, force = false, onlyTo, origin = SITE } = options

  await ensureSchema()
  const sql = db()
  const devices = testDevices()

  const latestRows = (await sql`
    select tst, lat, lon,
           extract(epoch from (now() - tst))::float8 as age_s
    from locations
    where (device = any(${devices}::text[])) = false
      and source = 'device'
    order by tst desc
    limit 1
  `) as unknown as { tst: string; lat: number; lon: number; age_s: number }[]

  const latest = latestRows[0]
  if (!latest) return { sent: false, reason: 'no fixes recorded yet' }

  const { zone, date: today, hour } = localNow(latest.lat, latest.lon)
  const base = { localDate: today, localHour: hour, timezone: zone }

  // Gate 1: his morning. Cheapest check, and true for most of the day, so it
  // goes first and keeps the other queries from running at all.
  const window = sendWindow()
  if (!force && (hour < window.from || hour > window.until)) {
    return {
      ...base,
      sent: false,
      reason: `outside the send window — ${hour}:00 where he is, sends between ${window.from}:00 and ${window.until}:59`,
    }
  }

  // Gate 2: not already done. The claim below is what actually prevents a
  // double send; this only avoids the work when the answer is already known.
  if (!force) {
    const already = (await sql`
      select 1 from sent_emails where local_date = ${today}::date and kind = 'daily'
    `) as unknown as unknown[]
    if (already.length > 0) {
      return { ...base, sent: false, reason: `already sent for ${today}` }
    }
  }

  // Gate 3: he is out there now, not last night.
  const ageMinutes = latest.age_s / 60
  if (!force && ageMinutes > MAX_FIX_AGE_MINUTES) {
    return {
      ...base,
      sent: false,
      reason: `last fix is ${Math.round(ageMinutes)} minutes old, so the live map would open on a stationary dot`,
    }
  }

  // Gate 4: he has actually started riding today.
  const movedRows = (await sql`
    with ordered as (
      select
        tst, lat, lon,
        lag(lat) over (order by tst) as plat,
        lag(lon) over (order by tst) as plon
      from locations
      where (device = any(${devices}::text[])) = false
        and source = 'device'
        and tst >= (${today}::date::timestamp at time zone ${zone}::text)
    )
    select coalesce(sum(
      case when plat is null then 0 else
        2 * 6371000 * asin(least(1, sqrt(
          power(sin(radians(lat - plat) / 2), 2) +
          cos(radians(plat)) * cos(radians(lat)) *
          power(sin(radians(lon - plon) / 2), 2)
        )))
      end
    ), 0)::float8 as today_m
    from ordered
  `) as unknown as { today_m: number }[]

  const todayKm = (movedRows[0]?.today_m ?? 0) / 1000
  if (!force && todayKm < MIN_MOVING_KM) {
    return {
      ...base,
      sent: false,
      reason: `only ${todayKm.toFixed(1)} km covered today, below the ${MIN_MOVING_KM} km that counts as moving`,
    }
  }

  // Gate 5: we know where he is heading. Without a matched riding leg there is
  // no destination, no planned distance and nothing to say — the schedule alone
  // is not evidence, since he can be days off it.
  const leg = currentLeg([latest.lon, latest.lat], today)
  if (!leg || leg.kind !== 'ride' || !leg.from) {
    return {
      ...base,
      sent: false,
      reason: leg
        ? `he is on a ${leg.kind} day at ${leg.to}, not riding to somewhere`
        : 'no itinerary leg matches where he is, so his destination is unknown',
    }
  }

  const record = dayRecords().find((d) => d.date === leg.date)
  if (!record?.fromCoords) {
    return { ...base, sent: false, reason: `no start coordinates for the leg dated ${leg.date}` }
  }

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date())

  const recipients = onlyTo
    ? [onlyTo]
    : (
        (await sql`
          select email from viewers
          where role in ('owner', 'viewer') and email_pref = 'daily'
          order by email
        `) as unknown as { email: string }[]
      ).map((r) => r.email)

  if (recipients.length === 0) {
    return { ...base, sent: false, reason: 'nobody is subscribed' }
  }

  const render = (to: string) =>
    buildDailyEmail({
      dayNumber: record.day,
      from: leg.from as string,
      to: leg.to,
      plannedMiles: leg.plannedMiles,
      dateLabel,
      fromCoords: record.fromCoords as [number, number],
      toCoords: leg.destination,
      milesSoFar: todayKm / KM_PER_MILE,
      liveUrl: `${origin}/track`,
      unsubscribeUrl: unsubscribeUrl(to, origin),
      mapboxToken: process.env.VITE_MAPBOX_TOKEN ?? process.env.MAPBOX_TOKEN ?? null,
    })

  const sample = render(recipients[0])

  if (dryRun) {
    return {
      ...base,
      sent: false,
      reason: 'dry run — everything checked out, nothing sent',
      subject: sample.subject,
      recipients,
      preview: sample,
    }
  }

  // Verifying the domain and going live are separate decisions. Without this,
  // the first real send happens the morning after a DNS record propagates,
  // which is no way to find out that forty people just got mail. A test send to
  // one owner is still allowed, because that is how the pause gets lifted with
  // any confidence.
  if (!onlyTo && process.env.EMAIL_PAUSED === '1') {
    return {
      ...base,
      sent: false,
      reason: 'EMAIL_PAUSED is set, so the broadcast is held; owner test sends still work',
      subject: sample.subject,
      recipients,
    }
  }

  if (!mailerConfigured()) {
    return {
      ...base,
      sent: false,
      reason: 'RESEND_API_KEY is not set, so delivery is not switched on yet',
      subject: sample.subject,
      recipients,
    }
  }

  // Claim the day before sending, not after. If the send half-fails, or the
  // function is killed mid-flight, the row is already there and the next run
  // will not mail everyone a second time. Sending twice is worse than not at
  // all: the first is a mistake people notice, the second they never see.
  if (!force && !onlyTo) {
    const claim = (await sql`
      insert into sent_emails (local_date, kind, recipients, subject)
      values (${today}::date, 'daily', ${recipients.length}, ${sample.subject})
      on conflict (local_date, kind) do nothing
      returning local_date
    `) as unknown as unknown[]
    if (claim.length === 0) {
      return { ...base, sent: false, reason: `another run claimed ${today} first` }
    }
  }

  const messages: OutgoingEmail[] = recipients.map((to) => {
    const mail = render(to)
    return {
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      unsubscribeUrl: unsubscribeUrl(to, origin),
    }
  })

  const result = await sendBatch(messages)

  // Resend's rejection text is the whole diagnosis — an unverified domain and a
  // malformed address fail identically otherwise — so it goes in the reason
  // rather than only in a field the admin panel does not show.
  // "Accepted" rather than "delivered", because that is all Resend can promise
  // at this point, and the difference is exactly what a silently quarantined
  // message looks like from here.
  const reason =
    result.failed.length > 0
      ? `accepted for ${result.sent} of ${recipients.length}; first failure: ${result.failed[0].error}`
      : `accepted by Resend for ${result.sent} of ${recipients.length}` +
        (result.ids.length > 0 ? ` — id ${result.ids[0]}` : '')

  return {
    ...base,
    sent: result.sent > 0,
    reason,
    subject: sample.subject,
    recipients,
    failed: result.failed,
    messageIds: result.ids,
  }
}
