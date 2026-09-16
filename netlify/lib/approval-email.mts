/**
 * The note that goes to somebody when an owner lets them in.
 *
 * The other half of a conversation that has only ever had one side. Asking for
 * access sends the owners a message; being granted it sent nothing at all, so
 * everybody approved so far has had to be told by hand — and anyone who was not
 * told is still sitting on a page saying an owner has not granted access yet,
 * which stopped being true days ago.
 *
 * Short on purpose. One fact and one button.
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

export interface ApprovalEmailInput {
  /** Their name if an owner has typed one, otherwise null. */
  name: string | null
  /** Site origin, so the link works from a deploy preview as well as live. */
  origin: string
  /** True when they were made an owner rather than a viewer. */
  asOwner: boolean
}

export function buildApprovalEmail(input: ApprovalEmailInput): {
  subject: string
  html: string
  text: string
} {
  const subject = "You're in — watch John ride"
  const greeting = input.name ? `${input.name}, you're in.` : "You're in."
  const lead = input.asOwner
    ? 'An owner has given you the tracker, and made you an owner too — so you can let other people in as well.'
    : 'An owner has let you in. The live map is open to you from now on.'

  // Said once, here, because it is the only thing about this that surprises
  // people: the link is not a password, and it will ask who they are.
  const note =
    'You may be asked to sign in again the first time. Use the same address this was sent to.'

  const url = `${input.origin}/track`

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
          <div style="font:700 22px/1.3 ${FONT};color:${TEXT};">${escape(greeting)}</div>
          <div style="font:400 16px/1.6 ${FONT};color:${MUTED};padding-top:10px;">${escape(lead)}</div>
        </td></tr>
        <tr><td align="center" style="padding:24px 28px 0;">
          <a href="${escape(url)}" style="display:inline-block;background:${BLUE};color:#fff;font:700 16px/1 ${FONT};text-decoration:none;padding:15px 34px;border-radius:10px;">Watch him live</a>
        </td></tr>
        <tr><td style="padding:22px 28px 28px;">
          <div style="font:400 13px/1.6 ${FONT};color:${MUTED};">${escape(note)}</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = [greeting, '', lead, '', url, '', note].join('\n')

  return { subject, html, text }
}
