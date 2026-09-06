import { db, ensureSchema } from './db.mts'
import { normalizeEmail } from './users.mts'

/**
 * Who somebody is, as opposed to what they typed.
 *
 * The distinction matters because two of the three ways in do not prove an
 * address. Google signs `email_verified` and means it. Microsoft signs nothing
 * of the kind — any tenant may set a user's email attribute to anything, and
 * this app accepts tokens from any tenant, because that is what letting a
 * stranger's university sign in requires. A magic link proves the address by
 * definition: it was delivered there and clicked.
 *
 * So an identity is a (provider, subject) pair, and it is bound to an address
 * only once that address has been proved. Access hangs off the binding. A token
 * arriving with a viewer's address and no binding gets nothing.
 */

export type Provider = 'google' | 'microsoft' | 'email'

export interface Identity {
  provider: Provider
  subject: string
  email: string
  firstName: string | null
  lastName: string | null
}

/**
 * The address this identity has been proved to own, or null if it has not.
 *
 * Null is the interesting answer: it means somebody has authenticated with a
 * real provider and is claiming an address nobody has watched them prove. That
 * is not a failure — it is how everyone starts — but it is not access either.
 */
export async function boundEmail(provider: Provider, subject: string): Promise<string | null> {
  await ensureSchema()
  const rows = (await db()`
    select email from auth_identities
    where provider = ${provider} and subject = ${subject}
  `) as unknown as { email: string }[]
  return rows[0]?.email ?? null
}

/**
 * Records that this identity owns this address, and stamps that we saw it.
 *
 * Called only where the address has actually been proved: a Google token whose
 * `email_verified` is true, or a magic link that arrived and was clicked. Never
 * from a claim.
 *
 * The subject is the primary key, so a person who changes address keeps their
 * identity and the row follows them — which is right, and is why the email is
 * updated on conflict rather than left as it was.
 */
export async function bindIdentity(identity: Identity): Promise<void> {
  await ensureSchema()
  const email = normalizeEmail(identity.email)
  await db()`
    insert into auth_identities (provider, subject, email, first_name, last_name)
    values (${identity.provider}, ${identity.subject}, ${email},
            ${identity.firstName}, ${identity.lastName})
    on conflict (provider, subject) do update set
      email = excluded.email,
      -- A name already on file wins: an owner may have corrected it, and the
      -- provider's version is whatever the person called themselves there.
      first_name = coalesce(auth_identities.first_name, excluded.first_name),
      last_name  = coalesce(auth_identities.last_name,  excluded.last_name),
      last_seen  = now()
  `
}

/**
 * Which way in this address used last, so it can be offered first next time.
 *
 * The alternative was guessing from the domain's MX records, which was tried
 * and does not work: Cornell's mail is Microsoft's and its people sign in with
 * Google, Mayo runs its own, and Harvard, Stanford and JPMorgan all sit behind
 * gateways that say nothing about who authenticates them. What somebody did
 * last time is observed rather than inferred, and is therefore right.
 */
export async function rememberProvider(email: string, provider: Provider): Promise<void> {
  await ensureSchema()
  await db()`
    update viewers set last_provider = ${provider}, updated_at = now()
    where email = ${normalizeEmail(email)}
  `
}

export async function lastProvider(email: string): Promise<Provider | null> {
  await ensureSchema()
  const rows = (await db()`
    select last_provider from viewers where email = ${normalizeEmail(email)}
  `) as unknown as { last_provider: string | null }[]
  const value = rows[0]?.last_provider
  return value === 'google' || value === 'microsoft' || value === 'email' ? value : null
}
