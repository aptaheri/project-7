import { db, ensureSchema } from './db.mts'
import type { Role } from './session.mts'

export type EmailPref = 'daily' | 'none'

export interface Viewer {
  email: string
  role: Role
  email_pref: EmailPref
  created_at: string
  updated_at: string
  granted_by: string | null
}

export const ROLES: Role[] = ['owner', 'viewer', 'pending']

/**
 * Canonical form of an address, used as the primary key everywhere.
 *
 * Gmail ignores dots and +tags in the local part and treats googlemail.com as
 * gmail.com, but Google's ID token only ever reports the canonical spelling.
 * Without this, pre-approving `john.smith@gmail.com` would not match a token
 * that says `johnsmith@gmail.com`. Only gmail is folded this way — for every
 * other domain a dot is significant and must be preserved.
 */
export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at === -1) return email

  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return email

  const withoutTag = local.split('+')[0]
  return `${withoutTag.split('.').join('')}@gmail.com`
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value)
}

export function canViewTrack(role: Role): boolean {
  return role === 'owner' || role === 'viewer'
}

/** Emails listed in TRACK_OWNER_EMAILS are owners, which bootstraps the first ones. */
function bootstrapOwners(): string[] {
  return (process.env.TRACK_OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => normalizeEmail(e))
    .filter(Boolean)
}

/**
 * Records a Google sign-in and returns the caller's role and email preference.
 *
 * Unknown emails land as 'pending' so an owner can see who asked without
 * having to know the address in advance. Bootstrap owners are promoted on
 * every sign-in, so losing owner access cannot lock everyone out.
 *
 * The preference comes back with the role because the tracker needs it to
 * decide whether to offer a resubscribe link, and one round trip is enough.
 */
export async function recordSignIn(email: string): Promise<{
  role: Role
  emailPref: EmailPref
}> {
  await ensureSchema()
  const sql = db()
  const address = normalizeEmail(email)

  if (bootstrapOwners().includes(address)) {
    await sql`
      insert into viewers (email, role, granted_by)
      values (${address}, 'owner', 'bootstrap')
      on conflict (email) do update set role = 'owner', updated_at = now()
    `
  } else {
    await sql`
      insert into viewers (email, role)
      values (${address}, 'pending')
      on conflict (email) do nothing
    `
  }

  const rows = (await sql`
    select role, email_pref from viewers where email = ${address}
  `) as unknown as { role: string; email_pref: string }[]

  return {
    role: isRole(rows[0]?.role) ? rows[0].role : 'pending',
    emailPref: isEmailPref(rows[0]?.email_pref) ? rows[0].email_pref : 'daily',
  }
}

export async function listViewers(): Promise<Viewer[]> {
  await ensureSchema()
  const sql = db()

  // Bootstrap owners have a role whether or not they have ever signed in, so
  // seed them here — otherwise the list silently omits people who do have
  // access and looks like they were never granted it.
  for (const email of bootstrapOwners()) {
    await sql`
      insert into viewers (email, role, granted_by)
      values (${email}, 'owner', 'bootstrap')
      on conflict (email) do update set role = 'owner', updated_at = now()
    `
  }

  return (await sql`
    select email, role, email_pref, created_at, updated_at, granted_by
    from viewers
    order by
      case role when 'pending' then 0 when 'owner' then 1 else 2 end,
      created_at desc
  `) as unknown as Viewer[]
}

export async function setRole(email: string, role: Role, grantedBy: string): Promise<void> {
  await ensureSchema()
  const sql = db()
  await sql`
    insert into viewers (email, role, granted_by)
    values (${normalizeEmail(email)}, ${role}, ${grantedBy})
    on conflict (email) do update
      set role = ${role}, granted_by = ${grantedBy}, updated_at = now()
  `
}

export function isEmailPref(value: unknown): value is EmailPref {
  return value === 'daily' || value === 'none'
}

/**
 * Turns the daily email on or off for one address.
 *
 * Separate from setRole because the two are genuinely different decisions:
 * whether someone may see the map is the owners' call, whether they want mail
 * about it is theirs. Unsubscribing never costs anyone their access.
 */
export async function setEmailPref(email: string, pref: EmailPref): Promise<void> {
  await ensureSchema()
  const sql = db()
  await sql`
    update viewers set email_pref = ${pref}, updated_at = now()
    where email = ${normalizeEmail(email)}
  `
}

export async function removeViewer(email: string): Promise<void> {
  await ensureSchema()
  const sql = db()
  await sql`delete from viewers where email = ${normalizeEmail(email)}`
}
