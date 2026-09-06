/**
 * The sign-in link, and the note that asks somebody to confirm an address.
 *
 * Short on purpose. This is a message with one job and a fifteen-minute life,
 * read on a phone by somebody who has just pressed a button and is waiting.
 * Same palette as the rest so it is recognisably from the same site.
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

export interface MagicEmailInput {
  url: string
  minutes: number
  /**
   * Set when the link exists to confirm an address a provider claimed rather
   * than to sign somebody in directly.
   *
   * Microsoft issues no `email_verified`, so the first time one of its accounts
   * says it owns an address, that is a claim. This is how the claim gets
   * checked, once, and it changes what the message has to say — the reader did
   * not ask for an email, they pressed "Microsoft".
   */
  confirming: 'microsoft' | null
}

export function buildMagicEmail(input: MagicEmailInput): {
  subject: string
  html: string
  text: string
} {
  const confirming = input.confirming !== null
  const subject = confirming
    ? 'Confirm your email for Project 7'
    : 'Your sign-in link for Project 7'

  const lead = confirming
    ? `You signed in with Microsoft. Because Microsoft does not tell us whether an address really belongs to the account, we ask once — click below and you will not be asked again.`
    : `Click below to sign in. The link works once and lasts ${input.minutes} minutes.`

  const action = confirming ? 'Confirm my email' : 'Sign in'

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${INK};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(lead)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:${PANEL};border-radius:14px;">
        <tr><td style="padding:28px 28px 0;">
          <div style="font:800 15px/1 ${FONT};color:${RED};letter-spacing:.06em;">PROJECT 7</div>
        </td></tr>
        <tr><td style="padding:18px 28px 0;">
          <div style="font:700 21px/1.3 ${FONT};color:${TEXT};">${escape(confirming ? 'Confirm your email' : 'Sign in to the tracker')}</div>
          <div style="font:400 16px/1.6 ${FONT};color:${MUTED};padding-top:10px;">${escape(lead)}</div>
        </td></tr>
        <tr><td align="center" style="padding:24px 28px 0;">
          <a href="${escape(input.url)}" style="display:inline-block;background:${BLUE};color:#fff;font:700 16px/1 ${FONT};text-decoration:none;padding:15px 34px;border-radius:10px;">${escape(action)}</a>
        </td></tr>
        <tr><td style="padding:22px 28px 28px;">
          <div style="font:400 13px/1.6 ${FONT};color:${MUTED};">
            If you did not ask for this, ignore it — nothing happens until the link is opened, and it stops working in ${input.minutes} minutes.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = [
    confirming ? 'Confirm your email' : 'Sign in to the tracker',
    '',
    lead,
    '',
    input.url,
    '',
    `If you did not ask for this, ignore it. The link stops working in ${input.minutes} minutes.`,
  ].join('\n')

  return { subject, html, text }
}
