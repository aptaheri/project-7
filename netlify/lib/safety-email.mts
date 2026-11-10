/**
 * The safety note to the owners, and the all-clear that follows it.
 *
 * Written for somebody reading it on a phone with a knot in their stomach: what
 * was seen, in one line; the facts that say how worried to be — how far short,
 * how long, the battery, the signal; what this usually turns out to be; and
 * where to look. It never claims to know what happened, because it cannot.
 */

import type { AlertKind } from './safety.mts'

const INK = '#0a0a0f'
const PANEL = '#14141c'
const RED = '#E31A28'
const GREEN = '#2ea043'
const BLUE = '#4285f4'
const TEXT = '#f3f4f6'
const MUTED = '#8b8f9a'

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

const KM_PER_MILE = 1.609344

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface SafetyEmailInput {
  kind: AlertKind
  /** The all-clear rather than the alert. */
  clearing: boolean
  /** His local time now, and of his latest fix. */
  localTime: string
  lastFix: string
  /** Quiet for, or still for, in minutes. */
  minutes: number
  riddenKm: number
  destination: string | null
  toDestinationKm: number | null
  /** [lon, lat] of the latest fix. */
  position: [number, number]
  battery: number | null
  /** OwnTracks' connection at the last fix: w, m or o. */
  connection: string | null
  /** On an all-clear after a quiet spell, how far the late-arriving fixes say he rode meanwhile. */
  rodeDuringGapKm: number | null
  settings: { quietMinutes: number; stillMinutes: number; stillRadiusM: number; nearKm: number; silentHour: number }
  origin: string
}

function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

function distance(km: number): string {
  return `${km.toFixed(km < 10 ? 1 : 0)} km (${(km / KM_PER_MILE).toFixed(km < 16 ? 1 : 0)} mi)`
}

function connectionLabel(conn: string | null): string | null {
  if (conn === 'w') return 'on Wi-Fi'
  if (conn === 'm') return 'on mobile data'
  if (conn === 'o') return 'with no connection'
  return null
}

export function buildSafetyEmail(input: SafetyEmailInput): {
  subject: string
  html: string
  text: string
} {
  const short =
    input.destination && input.toDestinationKm !== null
      ? `${distance(input.toDestinationKm)} short of ${input.destination}`
      : 'short of tonight\'s town'
  const mapsUrl = `https://www.google.com/maps?q=${input.position[1].toFixed(5)},${input.position[0].toFixed(5)}`
  const trackUrl = `${input.origin}/track`

  let subject: string
  let headline: string
  let summary: string
  let likely: string[]

  if (input.clearing) {
    subject =
      input.kind !== 'still'
        ? `All clear: John's fixes are coming in again`
        : `All clear: John is moving again`
    headline = input.kind !== 'still' ? 'His fixes are back' : 'He is moving again'
    const gap =
      input.rodeDuringGapKm !== null && input.rodeDuringGapKm >= 1
        ? ` Fixes recorded during the gap have now arrived and show him riding ${distance(input.rodeDuringGapKm)} through it — so it was the signal, not him.`
        : ''
    summary =
      `Latest fix at ${input.lastFix} his time` +
      (input.destination && input.toDestinationKm !== null
        ? `, ${distance(input.toDestinationKm)} from ${input.destination}.`
        : '.') +
      gap
    likely = []
  } else if (input.kind === 'silent') {
    subject = `Safety check: no fix from John yet today — last one ${duration(input.minutes)} ago`
    headline = 'No fix from John yet today'
    summary =
      `It is ${input.localTime} his time on a riding day, and nothing has arrived since ${input.lastFix}. ` +
      (input.destination && input.toDestinationKm !== null
        ? `Today's ride is to ${input.destination}, ${distance(input.toDestinationKm)} from where that fix was.`
        : 'Today is a riding day.')
    likely = [
      'No signal since he set off. OwnTracks keeps recording and sends everything when it reconnects, so the day fills in on its own.',
      'The phone died overnight, or has not been charged.',
      'OwnTracks was stopped or closed on the phone.',
      'He changed plans and is not riding today.',
      'Less often, a problem. If you have not heard from him, try reaching him.',
    ]
  } else if (input.kind === 'quiet') {
    subject = `Safety check: no fix from John for ${duration(input.minutes)}, ${short}`
    headline = `No fix from John for ${duration(input.minutes)}`
    summary =
      `His last fix was at ${input.lastFix} his time. He had ridden ${distance(input.riddenKm)} today ` +
      `and was ${short} when it stopped.`
    likely = [
      'No signal. This is the usual cause, especially across Central Asia. OwnTracks keeps recording and sends everything when it reconnects, so the gap fills in on its own.',
      'A flat or dying phone battery.',
      'A long stop indoors, at a café or a guesthouse that is not his destination.',
      'Less often, a problem. If he has not turned up by the time you would expect, try reaching him.',
    ]
  } else {
    subject = `Safety check: John hasn't moved for ${duration(input.minutes)}, ${short}`
    headline = `John hasn't moved for ${duration(input.minutes)}`
    summary =
      `His phone is still reporting, but every fix for ${duration(input.minutes)} has been within ` +
      `${input.settings.stillRadiusM} m of the same spot, ${short}. He had ridden ${distance(input.riddenKm)} today.`
    likely = [
      'A long lunch, or waiting out heat or wind. This is the usual cause.',
      'A mechanical problem he is fixing at the roadside.',
      'He has decided to stop somewhere short of the planned town for the night.',
      'Less often, a problem. If this goes on, try reaching him.',
    ]
  }

  const facts: [string, string][] = [
    ['His time now', input.localTime],
    ['Latest fix', `${input.lastFix} his time`],
  ]
  if (!input.clearing && input.kind !== 'silent') facts.push(['Ridden today', distance(input.riddenKm)])
  if (input.destination && input.toDestinationKm !== null) {
    facts.push([`To ${input.destination}`, `${distance(input.toDestinationKm)}, straight line`])
  }
  const phone = [
    input.battery !== null ? `battery ${input.battery}%` : null,
    connectionLabel(input.connection),
  ].filter(Boolean)
  if (phone.length) facts.push(['Phone at that fix', phone.join(', ')])

  const accent = input.clearing ? GREEN : RED
  const row = ([label, value]: [string, string]) => `
    <tr>
      <td style="font:600 12px/1.4 ${FONT};color:${MUTED};padding:6px 12px 6px 0;white-space:nowrap;vertical-align:top;">${escape(label)}</td>
      <td style="font:500 15px/1.4 ${FONT};color:${TEXT};padding:6px 0;">${escape(value)}</td>
    </tr>`

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(summary)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${PANEL};border-radius:16px;overflow:hidden;">

    <tr><td style="padding:28px 28px 0;">
      <div style="font:700 13px/1 ${FONT};color:${accent};letter-spacing:.18em;text-transform:uppercase;">Project 7 · ${input.clearing ? 'All clear' : 'Safety check'}</div>
    </td></tr>

    <tr><td style="padding:16px 28px 0;">
      <div style="font:700 26px/1.25 ${FONT};color:${TEXT};">${escape(headline)}</div>
      <div style="font:400 16px/1.55 ${FONT};color:${MUTED};padding-top:10px;">${escape(summary)}</div>
    </td></tr>

    <tr><td style="padding:22px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,.04);border-radius:12px;">
        <tr><td style="padding:14px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0">${facts.map(row).join('')}</table>
        </td></tr>
      </table>
    </td></tr>

    ${likely.length ? `<tr><td style="padding:22px 28px 0;">
      <div style="font:700 11px/1 ${FONT};color:${accent};letter-spacing:.12em;text-transform:uppercase;">What this usually is</div>
      <ul style="margin:12px 0 0;padding-left:20px;font:400 15px/1.55 ${FONT};color:${TEXT};">
        ${likely.map((l) => `<li style="padding-bottom:6px;">${escape(l)}</li>`).join('')}
      </ul>
    </td></tr>` : ''}

    <tr><td style="padding:22px 28px 4px;">
      <a href="${escape(trackUrl)}" style="display:inline-block;background:${BLUE};color:#fff;text-decoration:none;font:600 15px/1 ${FONT};padding:14px 22px;border-radius:999px;margin:0 8px 8px 0;">Open the live map</a>
      <a href="${escape(mapsUrl)}" style="display:inline-block;background:rgba(255,255,255,.08);color:${TEXT};text-decoration:none;font:600 15px/1 ${FONT};padding:14px 22px;border-radius:999px;margin:0 0 8px;">Last position in Google Maps</a>
    </td></tr>

    <tr><td style="padding:14px 28px 28px;">
      <div style="font:400 13px/1.5 ${FONT};color:${MUTED};">
        ${escape(
          input.clearing
            ? 'Sent to owners only.'
            : `Sent to owners only. You'll get one more email when ${input.kind === 'still' ? 'he moves on' : 'his fixes resume'}. ` +
              `This fires on a riding day while he is more than ${input.settings.nearKm} km from the night's town: ` +
              `once he has set off, after ${input.settings.quietMinutes} min with no fix or ${input.settings.stillMinutes} min within ${input.settings.stillRadiusM} m; ` +
              `and from ${input.settings.silentHour}:00 his time if nothing has arrived since midnight.`,
        )}
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`

  const text = [
    headline,
    '',
    summary,
    '',
    ...facts.map(([l, v]) => `${l}: ${v}`),
    '',
    ...(likely.length ? ['What this usually is:', ...likely.map((l) => `- ${l}`), ''] : []),
    `Live map: ${trackUrl}`,
    `Last position: ${mapsUrl}`,
    '',
    input.clearing ? 'Sent to owners only.' : 'Sent to owners only. One more email will follow when this clears.',
    '',
  ].join('\n')

  return { subject, html, text }
}
