import { db, ensureSchema } from '../lib/db.mts'
import { verifyUnsubscribeToken } from '../lib/mailer.mts'

/**
 * Leaving, in one click and without signing in.
 *
 * The signed token in the link is the only credential, which is the point: a
 * person who wants the mail to stop should not have to remember which Google
 * account they used. It changes the email preference and nothing else — their
 * access to the tracker is untouched.
 */

const PAGE = (heading: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} — Project 7</title></head>
<body style="margin:0;background:#0a0a0f;color:#f3f4f6;font:400 17px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:96px 24px;">
  <div style="font:700 13px/1 -apple-system,sans-serif;color:#E31A28;letter-spacing:.18em;text-transform:uppercase;">Project 7</div>
  <h1 style="font-size:30px;line-height:1.25;margin:22px 0 14px;">${heading}</h1>
  <p style="color:#8b8f9a;margin:0 0 28px;">${body}</p>
  <a href="/track" style="color:#4285f4;text-decoration:none;font-weight:600;">Go to the live map &rarr;</a>
</div>
</body></html>`

function page(heading: string, body: string, status = 200): Response {
  return new Response(PAGE(heading, body), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export default async function handler(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('t')
  const email = verifyUnsubscribeToken(token)

  if (!email) {
    return page(
      'That link has expired',
      'We could not read that unsubscribe link. Reply to any of the emails and we will take you off the list by hand.',
      400,
    )
  }

  await ensureSchema()
  await db()`
    update viewers set email_pref = 'none', updated_at = now() where email = ${email}
  `

  return page(
    'You are unsubscribed',
    `No more daily emails to ${email}. You can still watch the map any time, and you can turn the emails back on from the tracker.`,
  )
}
