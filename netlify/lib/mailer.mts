import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Delivery, and the signed links that let someone leave.
 *
 * Resend is called over plain HTTP rather than through their SDK: one endpoint,
 * one shape, and nothing to keep upgraded in a function that has to stay small.
 */

const RESEND_BATCH_URL = 'https://api.resend.com/emails/batch'

/** Resend's own ceiling on one batch call. */
const BATCH_LIMIT = 100

export interface OutgoingEmail {
  to: string
  subject: string
  html: string
  text: string
  /** Put in List-Unsubscribe so mail clients can offer their own button. */
  unsubscribeUrl: string
}

function secret(): string {
  const value = process.env.SESSION_SECRET
  if (!value) throw new Error('SESSION_SECRET is not set')
  return value
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(`unsub:${payload}`).digest('base64url')
}

/**
 * A permanent, unguessable token for one address.
 *
 * Deliberately without an expiry: an unsubscribe link has to work the day
 * someone finally gets round to clicking it, months after the email arrived.
 * It grants nothing except the ability to stop mail to that one address, so
 * there is nothing worth stealing. The `unsub:` prefix in the signature keeps
 * it from being interchangeable with a session token.
 */
export function unsubscribeToken(email: string): string {
  const payload = Buffer.from(email, 'utf8').toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyUnsubscribeToken(token: string | null): string | null {
  if (!token) return null

  const dot = token.lastIndexOf('.')
  if (dot < 1) return null

  const payload = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1), 'utf8')
  const expected = Buffer.from(sign(payload), 'utf8')

  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  const email = Buffer.from(payload, 'base64url').toString('utf8')
  return email.includes('@') ? email : null
}

export function unsubscribeUrl(email: string, origin: string): string {
  return `${origin}/api/unsubscribe?t=${encodeURIComponent(unsubscribeToken(email))}`
}

export function mailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

function fromAddress(): string {
  return process.env.EMAIL_FROM ?? 'Project 7 <updates@project7.bike>'
}

export interface SendResult {
  sent: number
  failed: { to: string; error: string }[]
}

/**
 * Sends one personalised message per recipient, in batches.
 *
 * Not a single email with everyone in bcc: each one carries its own unsubscribe
 * link, and a bcc list of forty addresses is both a privacy leak waiting to
 * happen and a reliable way into spam folders.
 */
export async function sendBatch(emails: OutgoingEmail[]): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')

  const result: SendResult = { sent: 0, failed: [] }

  for (let i = 0; i < emails.length; i += BATCH_LIMIT) {
    const chunk = emails.slice(i, i + BATCH_LIMIT)
    const body = chunk.map((email) => ({
      from: fromAddress(),
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: {
        'List-Unsubscribe': `<${email.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }))

    const response = await fetch(RESEND_BATCH_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      // The whole chunk failed together, so attribute it to every address in
      // it rather than losing which people did not get mail.
      const detail = (await response.text()).slice(0, 300)
      for (const email of chunk) {
        result.failed.push({ to: email.to, error: `${response.status} ${detail}` })
      }
      continue
    }

    result.sent += chunk.length
  }

  return result
}
