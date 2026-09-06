import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { db, ensureSchema } from './db.mts'
import { normalizeEmail } from './users.mts'

/**
 * Sign-in for everybody whose mail is neither Google's nor Microsoft's.
 *
 * On the addresses actually on this list that is most of them: of the
 * universities and companies John's friends work at, the ones behind Proofpoint
 * or a mail server of their own outnumber the ones on a provider we can talk
 * to. A link in an inbox is the one method that works for all of them.
 *
 * It is also the strongest proof of the three, which is the part worth saying
 * out loud. Google's token carries `email_verified` and Microsoft's carries
 * nothing of the kind — but clicking a link that was delivered to an address
 * *is* possession of that address, which is exactly what "this person is
 * approved" has always meant here.
 */

/**
 * How long a link is good for.
 *
 * Long enough to walk to a laptop, short enough that a mail archive is not a
 * standing key to the tracker. Corporate mail can sit in a scanner for a minute
 * or two before delivery, so anything under ten minutes starts failing for the
 * people this exists to serve.
 */
const TTL_MINUTES = 15

/** 32 bytes from the CSPRNG. Guessing one is not a threat model. */
const TOKEN_BYTES = 32

/**
 * How many live links one address may hold.
 *
 * Clicking "email me a link" three times because the first was slow should not
 * invalidate the copy already on its way — all three work until one is used.
 * But an address is not allowed to accumulate them without limit, or the table
 * becomes a way to make us send mail.
 */
const MAX_LIVE_PER_EMAIL = 5

/**
 * Stored hashed, never in the clear.
 *
 * The row is a record that a link exists, not the link itself. A leaked table
 * of live tokens would be a leaked set of sessions; a leaked table of hashes is
 * not, and nothing ever needs the original back — redemption hashes what
 * arrives and looks for the result.
 *
 * Plain SHA-256 rather than a password hash on purpose: this is 256 bits of
 * CSPRNG output with no structure to attack, so there is nothing for a slow
 * hash to defend against, and redemption happens on a request somebody is
 * waiting on.
 */
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface IssuedLink {
  /** The secret, returned once, for putting in the email and nowhere else. */
  token: string
  expiresAt: Date
}

/**
 * Mints a link for an address, whether or not anybody by that name is known.
 *
 * Deliberately indifferent to whether the address is a viewer, is pending, or
 * has never been seen: the caller says the same thing back either way. An
 * endpoint that only sends mail to addresses it recognises is an endpoint that
 * tells the internet which of John's friends are on the list.
 */
export async function issueLink(rawEmail: string): Promise<IssuedLink> {
  await ensureSchema()
  const sql = db()
  const email = normalizeEmail(rawEmail)

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000)

  // Cast explicitly rather than leaning on the driver to infer it: the
  // timestamp goes over the wire as text, and a column that takes it only by
  // lucky coercion is the kind of thing that works until the driver changes.
  await sql`
    insert into magic_link_tokens (token_hash, email, expires_at)
    values (${hash(token)}, ${email}, ${expiresAt.toISOString()}::timestamptz)
  `

  // Oldest first, so the link that has just been sent is never the one dropped.
  await sql`
    delete from magic_link_tokens
    where email = ${email}
      and used_at is null
      and expires_at > now()
      and token_hash not in (
        select token_hash from magic_link_tokens
        where email = ${email} and used_at is null and expires_at > now()
        order by created_at desc
        limit ${MAX_LIVE_PER_EMAIL}
      )
  `

  return { token, expiresAt }
}

export type RedeemResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' }

/**
 * Spends a link, and says which way it failed when it does.
 *
 * The three failures are told apart because they are different things to a
 * person holding a dead link — a second click on one that worked is not the
 * same as a link that sat unread for an hour, and neither is a typo. None of
 * them leaks anything: you have to be holding the token to get any of these
 * answers, and holding it is the whole secret.
 *
 * Marking it used is the same statement that reads it, so two clicks arriving
 * together cannot both find it unused. `used_at is null` in the WHERE is what
 * makes that true; checking first and updating after would be a race that a
 * mail scanner following links is well placed to win.
 */
export async function redeemLink(token: string): Promise<RedeemResult> {
  await ensureSchema()
  const sql = db()

  const spent = (await sql`
    update magic_link_tokens
       set used_at = now()
     where token_hash = ${hash(token)}
       and used_at is null
       and expires_at > now()
    returning email
  `) as unknown as { email: string }[]

  if (spent.length > 0) return { ok: true, email: spent[0].email }

  // Nothing was spent. Say why, from the row itself if there is one.
  const existing = (await sql`
    select used_at, expires_at < now() as expired
    from magic_link_tokens where token_hash = ${hash(token)}
  `) as unknown as { used_at: string | null; expired: boolean }[]

  if (existing.length === 0) return { ok: false, reason: 'unknown' }
  if (existing[0].used_at !== null) return { ok: false, reason: 'used' }
  return { ok: false, reason: 'expired' }
}

/**
 * Compares two tokens without leaking how far they matched.
 *
 * Not used by redemption, which looks a hash up by primary key and never
 * compares anything, but exported for any caller that does hold two secrets and
 * needs to know whether they are the same.
 */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Drops links that are dead, so the table stays the size of a day's traffic.
 *
 * Spent and expired rows are kept briefly rather than deleted on use: it is
 * what lets a second click say "this link has already been used" instead of
 * "no such link", which is the difference between an explanation and a
 * mystery. Called from the scheduled work, not from a sign-in.
 */
export async function sweepLinks(olderThanHours = 24): Promise<number> {
  await ensureSchema()
  const sql = db()
  const gone = (await sql`
    delete from magic_link_tokens
     -- ::int because the driver sends a number as int8 and make_interval
     -- takes int4; without it this is a function that does not exist.
     where created_at < now() - make_interval(hours => ${olderThanHours}::int)
    returning token_hash
  `) as unknown as unknown[]
  return gone.length
}

export const MAGIC_TTL_MINUTES = TTL_MINUTES
