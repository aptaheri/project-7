import facts from '../../src/data/destination-facts.json'

/**
 * The morning email: John has started riding, here is where he is going.
 *
 * Written as tables with inline styles because that is what email clients
 * still understand — Outlook in particular ignores most modern layout. The
 * palette matches the site so the two read as the same thing.
 */

export interface DailyEmailInput {
  /** Day number of the expedition, from the itinerary. */
  dayNumber: number
  from: string
  to: string
  plannedMiles: number | null
  /** The rider's local date, already formatted for display. */
  dateLabel: string
  fromCoords: [number, number]
  toCoords: [number, number]
  /** Distance covered before the email fires, in miles. */
  milesSoFar: number
  liveUrl: string
  unsubscribeUrl: string
  mapboxToken: string | null
}

const SITE = 'https://project7.bike'
const GOFUNDME = 'https://www.gofundme.com/f/support-marty-lyons-foundations-mission'
const INSTAGRAM = 'https://www.instagram.com/jm_nitti'

const INK = '#0a0a0f'
const PANEL = '#14141c'
const RED = '#E31A28'
const BLUE = '#4285f4'
const TEXT = '#f3f4f6'
const MUTED = '#8b8f9a'

/**
 * A light second line, worked out from the day's distance.
 *
 * Every one of these is arithmetic rather than invention — the comparison is
 * true or it does not go in. The point is to make a number mean something to
 * people who do not ride, and there are three hundred more of these to come, so
 * it rotates by day rather than repeating the same joke until it dies.
 */
const SCALE_LINES: ((miles: number) => string)[] = [
  (m) =>
    `That's ${(m / 26.2).toFixed(1)} marathons back to back, except nobody hands you a medal at the end of each one.`,
  (m) => `About ${Math.round((m * 1609.344) / 400)} laps of a running track. Try not to picture it.`,
  (m) =>
    `Roughly ${(m / 13.4).toFixed(1)} times the length of Manhattan, end to end, with luggage.`,
  (m) =>
    `The English Channel is 21 miles across at its narrowest. Today is ${(m / 21).toFixed(1)} of those, with hills.`,
  (m) =>
    `About ${Math.round(m)} minutes of this would be a car journey at motorway speed. It will take him rather longer.`,
  (m) => `Walking it would take about ${Math.round(m / 3)} hours without stopping.`,
  (m) => `${Math.round(m / 6.1)} laps of Central Park, more or less.`,
  (m) =>
    `A Tour de France stage averages around 100 miles. Today is ${(m / 100).toFixed(1)} of one — no team car, no soigneur.`,
]

export function scaleLine(miles: number | null, dayNumber: number): string | null {
  if (miles === null || miles < 20) return null
  // Keyed to the day so the preview and the sent email always agree, and so
  // consecutive mornings never land on the same comparison.
  return SCALE_LINES[dayNumber % SCALE_LINES.length](miles)
}

export function factFor(destination: string): string | null {
  const table = (facts as { facts: Record<string, string> }).facts
  return table[destination] ?? null
}

/**
 * A satellite image of today's leg, start pin to finish pin.
 *
 * A map beats a stock photo here: it is always the right place, needs no
 * per-town curation or licensing, and shows the thing people actually want to
 * see — the road he is on today.
 */
export function legMapUrl(
  from: [number, number],
  to: [number, number],
  token: string,
): string {
  const pin = (coords: [number, number], label: string, colour: string) =>
    `pin-s-${label}+${colour.replace('#', '')}(${coords[0].toFixed(4)},${coords[1].toFixed(4)})`
  const overlay = `${pin(from, 'a', BLUE)},${pin(to, 'b', RED)}`
  return (
    'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/' +
    // Sized for the 544px column at 2x, not the 2400px the larger request
    // returned — that was 750 KB of email for no visible gain.
    `${overlay}/auto/544x236@2x?padding=44&access_token=${token}`
  )
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function buildDailyEmail(input: DailyEmailInput): {
  subject: string
  html: string
  text: string
} {
  const fact = factFor(input.to)
  const scale = scaleLine(input.plannedMiles, input.dayNumber)
  const planned = input.plannedMiles !== null ? `${input.plannedMiles} miles` : null
  const mapUrl = input.mapboxToken
    ? legMapUrl(input.fromCoords, input.toCoords, input.mapboxToken)
    : null

  const subject = planned
    ? `John's riding: ${input.from} → ${input.to}, ${planned}`
    : `John's riding: ${input.from} → ${input.to}`

  const stat = (label: string, value: string) => `
    <td align="center" style="padding:0 8px;">
      <div style="font:700 26px/1.1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};">${escape(value)}</div>
      <div style="font:600 11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};letter-spacing:.08em;text-transform:uppercase;padding-top:6px;">${escape(label)}</div>
    </td>`

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
  ${escape(fact ? fact.slice(0, 110) : `Day ${input.dayNumber} of seven continents by bike.`)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${PANEL};border-radius:16px;overflow:hidden;">

    <tr><td style="padding:28px 28px 0;">
      <div style="font:700 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${RED};letter-spacing:.18em;text-transform:uppercase;">Project 7</div>
      <div style="font:500 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};padding-top:10px;">Day ${input.dayNumber} &middot; ${escape(input.dateLabel)}</div>
    </td></tr>

    <tr><td style="padding:18px 28px 0;">
      <div style="font:700 30px/1.22 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};">
        ${escape(input.from)} <span style="color:${BLUE};">&rarr;</span> ${escape(input.to)}
      </div>
      <div style="font:400 16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};padding-top:10px;">
        He's on the road${planned ? `, with ${escape(planned)} to cover` : ''}. You can watch him move.
      </div>
    </td></tr>

    ${mapUrl ? `<tr><td style="padding:22px 28px 0;">
      <img src="${escape(mapUrl)}" width="544" alt="Today's route from ${escape(input.from)} to ${escape(input.to)}" style="display:block;width:100%;max-width:544px;height:auto;border-radius:12px;border:1px solid rgba(255,255,255,.08);">
    </td></tr>` : ''}

    <tr><td style="padding:24px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,.04);border-radius:12px;">
        <tr><td style="padding:18px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${stat('Planned', planned ? `${input.plannedMiles} mi` : '—')}
            ${stat('So far today', `${input.milesSoFar.toFixed(1)} mi`)}
            ${stat('Day', String(input.dayNumber))}
          </tr></table>
        </td></tr>
      </table>
    </td></tr>

    ${fact ? `<tr><td style="padding:24px 28px 0;">
      <div style="border-left:3px solid ${RED};padding:2px 0 2px 16px;">
        <div style="font:600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};letter-spacing:.1em;text-transform:uppercase;">About ${escape(input.to)}</div>
        <div style="font:400 16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};padding-top:9px;">${escape(fact)}</div>
      </div>
    </td></tr>` : ''}

    ${scale ? `<tr><td style="padding:18px 28px 0;">
      <div style="font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};font-style:italic;">${escape(scale)}</div>
    </td></tr>` : ''}

    <tr><td align="center" style="padding:28px;">
      <a href="${escape(input.liveUrl)}" style="display:inline-block;background:${BLUE};color:#fff;font:700 16px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-decoration:none;padding:15px 34px;border-radius:10px;">Watch him live</a>
    </td></tr>

    <tr><td style="padding:0 28px 26px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid rgba(255,255,255,.08);">
        <tr><td style="padding-top:20px;">
          <div style="font:400 14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};">
            John rides for the <a href="${GOFUNDME}" style="color:${BLUE};text-decoration:none;">Marty Lyons Foundation</a>, which grants wishes to children with terminal and life-threatening illnesses. Every dollar goes to them, none to the trip.
          </div>
          <div style="font:400 14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};padding-top:12px;">
            He posts from the road on <a href="${INSTAGRAM}" style="color:${BLUE};text-decoration:none;">Instagram</a>.
          </div>
        </td></tr>
      </table>
    </td></tr>

  </table>

  <div style="font:400 12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#5c606b;padding:18px 8px 0;max-width:600px;">
    You're getting this because you have access to John's tracker.
    <a href="${escape(input.unsubscribeUrl)}" style="color:#5c606b;">Stop these emails</a> &middot;
    <a href="${SITE}" style="color:#5c606b;">project7.bike</a>
  </div>
</td></tr>
</table>
</body>
</html>`

  const text = [
    `PROJECT 7 — Day ${input.dayNumber}, ${input.dateLabel}`,
    '',
    `${input.from} -> ${input.to}${planned ? ` (${planned})` : ''}`,
    `${input.milesSoFar.toFixed(1)} miles covered so far today.`,
    '',
    fact ? `About ${input.to}: ${fact}` : null,
    fact ? '' : null,
    scale,
    scale ? '' : null,
    `Watch him live: ${input.liveUrl}`,
    '',
    `John rides for the Marty Lyons Foundation: ${GOFUNDME}`,
    `Instagram: ${INSTAGRAM}`,
    '',
    `Stop these emails: ${input.unsubscribeUrl}`,
  ]
    .filter((line) => line !== null)
    .join('\n')

  return { subject, html, text }
}
