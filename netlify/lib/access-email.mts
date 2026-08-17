/**
 * The note that goes to the owners when somebody asks to see the tracker.
 *
 * Kept apart from the daily email: that one is a broadcast to forty people who
 * signed up for it, this is a notification to the two or three who can act on
 * it. Same palette so it is recognisably from the same site, but short, because
 * the whole message is one name, one address and one link.
 */

const INK = '#0a0a0f'
const PANEL = '#14141c'
const RED = '#E31A28'
const BLUE = '#4285f4'
const TEXT = '#f3f4f6'
const MUTED = '#8b8f9a'

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface AccessRequestInput {
  /** Whoever asked, as Google reported them. Null when Google gave no name. */
  name: string | null
  email: string
  /** Site origin, so the link works from a deploy preview as well as live. */
  origin: string
}

export function buildAccessRequestEmail(input: AccessRequestInput): {
  subject: string
  html: string
  text: string
} {
  // The name is the useful half of the subject line — an owner reading a phone
  // notification should recognise the person without opening anything. The
  // address stands in when Google gave no name, which beats "Somebody".
  const who = input.name ?? input.email
  const subject = `Tracker access requested: ${who}`
  const sharingUrl = `${input.origin}/track/sharing`

  const row = (label: string, value: string) => `
    <tr>
      <td style="font:600 11px/1.4 ${FONT};color:${MUTED};letter-spacing:.08em;text-transform:uppercase;padding:0 0 4px;">${escape(label)}</td>
    </tr>
    <tr>
      <td style="font:500 17px/1.4 ${FONT};color:${TEXT};padding:0 0 18px;">${escape(value)}</td>
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">
  ${escape(`${who} signed in and is waiting for an owner to approve them.`)}
</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${PANEL};border-radius:16px;overflow:hidden;">

    <tr><td style="padding:28px 28px 0;">
      <div style="font:700 13px/1 ${FONT};color:${RED};letter-spacing:.18em;text-transform:uppercase;">Project 7</div>
    </td></tr>

    <tr><td style="padding:16px 28px 0;">
      <div style="font:700 26px/1.25 ${FONT};color:${TEXT};">Someone asked to follow along</div>
      <div style="font:400 16px/1.55 ${FONT};color:${MUTED};padding-top:10px;">
        They have signed in and are waiting on an owner. Until one of you grants
        them the viewer role they cannot see the map.
      </div>
    </td></tr>

    <tr><td style="padding:24px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,.04);border-radius:12px;">
        <tr><td style="padding:20px 22px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${input.name ? row('Name', input.name) : ''}
            ${row('Email', input.email)}
          </table>
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:24px 28px 4px;">
      <a href="${escape(sharingUrl)}" style="display:inline-block;background:${BLUE};color:#fff;text-decoration:none;font:600 15px/1 ${FONT};padding:14px 22px;border-radius:999px;">Open the sharing page</a>
    </td></tr>

    <tr><td style="padding:18px 28px 28px;">
      <div style="font:400 13px/1.5 ${FONT};color:${MUTED};">
        ${input.name ? '' : 'Google gave no name for this account, so there is only an address to go on. '}You can set or correct anyone's name on that page.
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`

  const text = [
    'Someone asked to follow along on Project 7.',
    '',
    ...(input.name ? [`Name:  ${input.name}`] : []),
    `Email: ${input.email}`,
    '',
    'They are waiting on an owner to grant them the viewer role. Approve or',
    'decline from the sharing page:',
    sharingUrl,
    '',
  ].join('\n')

  return { subject, html, text }
}
