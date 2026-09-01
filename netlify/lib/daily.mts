import tzLookup from 'tz-lookup'
import itinerary from '../../src/data/itinerary.json'
import { db, ensureSchema } from './db.mts'
import { factFor } from './fact.mts'
import { buildDailyEmail } from './email.mts'
import { countryAt } from './country.mts'
import { currentLeg } from './itinerary.mts'
import { lineForEmail, loadRoute } from './route.mts'
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

/**
 * Hours of slack either side of the window when guessing from the plan.
 *
 * The guess uses where the itinerary says he should be, which can be a few
 * hundred kilometres from where he is. Timezones are wide, but the slack means
 * being wrong about the zone still cannot skip a morning.
 */
const GUESS_SLACK_HOURS = 2

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
  /**
   * Send today's email to the whole list now, because an owner said so.
   *
   * The schedule can only ever decide *not* to send: every gate it applies is a
   * reason to stay quiet, and once the window has passed there is no way back.
   * A morning it skipped for a good reason at 7am — he had not set off yet — is
   * still a morning worth writing about at two in the afternoon, and until this
   * existed the only way to recover one was to wait for the next.
   *
   * So this is deliberately not another gate to satisfy. It is a person who has
   * looked at the map answering the movement and clock questions themselves,
   * and it records the day as sent so the schedule does not send it again.
   */
  broadcast?: boolean
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

/**
 * The rider's local hour guessed from the plan, without touching the database.
 *
 * Nearly every run of this function happens while he is asleep or already off
 * the bike, and the only thing it needs in order to stop is the time where he
 * is — which needs his position, which used to mean a query. Waking a database
 * that bills by the hour, every half hour, to learn that it is the middle of
 * the night, was most of what this feature cost to run.
 *
 * The itinerary is compiled into the bundle, so it answers for free. Returns
 * null when the plan says nothing about today, which falls through to the real
 * check rather than guessing.
 */
function plannedLocalHour(): number | null {
  const utcDate = new Date().toISOString().slice(0, 10)
  const planned = dayRecords().find((d) => d.date === utcDate)
  const coords = planned?.toCoords ?? planned?.fromCoords
  if (!coords) return null

  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tzLookup(coords[1], coords[0]),
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    )
  } catch {
    return null
  }
}

function testDevices(): string[] {
  return (process.env.TRACK_TEST_DEVICES ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
}

export async function runDailyEmail(options: DailyOptions = {}): Promise<DailyOutcome> {
  const { dryRun = false, force = false, broadcast = false, onlyTo, origin = SITE } = options

  // A broadcast overrules exactly what force overrules: the clock, the fix
  // age, the movement, and the record of having already sent. Deriving that
  // here rather than at the call site keeps a caller that passes broadcast on
  // its own from getting a half-forced run, which is how the already-sent gate
  // came to turn away the one send that existed to overrule it.
  const ungated = force || broadcast

  const window = sendWindow()

  // Gate 0: is it even plausibly morning where he is? Answered from the
  // itinerary, so a run that stops here costs nothing at all — no connection,
  // no query, no waking a database that charges for being awake.
  if (!ungated) {
    const guess = plannedLocalHour()
    if (guess !== null && (guess < window.from - GUESS_SLACK_HOURS || guess > window.until + GUESS_SLACK_HOURS)) {
      return {
        sent: false,
        reason: `roughly ${guess}:00 along today's planned route, far enough outside the window to skip without a lookup`,
      }
    }
  }

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

  // Gate 1: his morning, now from his actual position rather than the plan.
  if (!ungated && (hour < window.from || hour > window.until)) {
    return {
      ...base,
      sent: false,
      reason: `outside the send window — ${hour}:00 where he is, sends between ${window.from}:00 and ${window.until}:59`,
    }
  }

  // Gate 2: not already done. The claim below is what actually prevents a
  // double send; this only avoids the work when the answer is already known.
  if (!ungated) {
    const already = (await sql`
      select 1 from sent_emails where local_date = ${today}::date and kind = 'daily'
    `) as unknown as unknown[]
    if (already.length > 0) {
      return { ...base, sent: false, reason: `already sent for ${today}` }
    }
  }

  // Gate 3: he is out there now, not last night.
  const ageMinutes = latest.age_s / 60
  if (!ungated && ageMinutes > MAX_FIX_AGE_MINUTES) {
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
  if (!ungated && todayKm < MIN_MOVING_KM) {
    return {
      ...base,
      sent: false,
      reason: `only ${todayKm.toFixed(1)} km covered today, below the ${MIN_MOVING_KM} km that counts as moving`,
    }
  }

  // Gate 5: we know where he is heading. Without a matched riding leg there is
  // no destination, no planned distance and nothing to say — the schedule alone
  // is not evidence, since he can be days off it.
  // The route as it now stands, so a reroute he entered last night reaches this
  // morning's email rather than waiting for somebody to edit a file.
  const route = await loadRoute()
  const leg = currentLeg([latest.lon, latest.lat], today, route)
  if (!leg || leg.kind !== 'ride' || !leg.from) {
    return {
      ...base,
      sent: false,
      reason: leg
        ? `he is on a ${leg.kind} day at ${leg.to}, not riding to somewhere`
        : 'no itinerary leg matches where he is, so his destination is unknown',
    }
  }

  // From the route as it now stands, not the plan. These two disagreed once
  // John started editing his own route: the header read "Saint-Marcellin →
  // Albertville" from the live route while the map's start pin sat on Chambéry,
  // because that is what the plan still said for the 27th. A name and a
  // coordinate for the same place have to come from the same place.
  const record = route.find((d) => d.date === leg.date)
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

  // A lookup, not a generation: writing one takes thirteen seconds and this
  // function has thirty to send forty emails. fact-warm.mts writes them hours
  // earlier; a destination it has not reached yet simply has no line.
  const { fact, distance } = await factFor(leg.to)

  // Drawn on the map in the email when the day has been routed; two pins and a
  // straight line when it has not, exactly as before.
  // Where in the world this is. Most recipients have never heard of Saint-
  // Marcellin or Albertville, and a day's ride that crosses a border is worth
  // saying out loud — this route changes country seventeen times.
  const [fromCountry, toCountry] = await Promise.all([
    countryAt(record.fromCoords[1], record.fromCoords[0]),
    countryAt(leg.destination[1], leg.destination[0]),
  ])

  const plannedToday = route.find((d) => d.date === leg.date)?.routeCoords ?? null
  const routeLineToday = plannedToday?.length ? lineForEmail(plannedToday) : null

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
      fact,
      distanceLine: distance,
      // The roads he means to ride, thinned to fit inside a static-map URL.
      routeLine: routeLineToday,
      country: toCountry
        ? {
            name: toCountry.name,
            flag: toCountry.flag,
            // Only when the day actually crosses one; otherwise it reads as
            // though every ride were an international departure.
            crossingFrom:
              fromCountry && fromCountry.code !== toCountry.code
                ? { name: fromCountry.name, flag: fromCountry.flag }
                : null,
          }
        : null,
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
  //
  // A broadcast is the deliberate opposite of a claim. It is how a morning the
  // schedule missed gets sent at all, so an existing row is the very thing it
  // has been asked to overrule rather than a reason to stop — a day claimed by
  // a run whose send then failed would otherwise stay unsendable forever. It
  // still writes the row, so the hourly schedule will not send it a second
  // time. Nothing reaches this branch by accident: it needs an owner session
  // and an explicit send=all.
  if (!onlyTo) {
    if (broadcast) {
      await sql`
        insert into sent_emails (local_date, kind, recipients, subject)
        values (${today}::date, 'daily', ${recipients.length}, ${sample.subject})
        on conflict (local_date, kind) do update set
          sent_at = now(),
          recipients = excluded.recipients,
          subject = excluded.subject
      `
    } else if (!force) {
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
