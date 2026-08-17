import { db, ensureSchema } from './db.mts'
import type { Role } from './session.mts'

export type EmailPref = 'daily' | 'none'

export interface Viewer {
  email: string
  role: Role
  email_pref: EmailPref
  first_name: string | null
  last_name: string | null
  created_at: string
  updated_at: string
  granted_by: string | null
  /**
   * True when TRACK_OWNER_EMAILS is what makes this an owner, so the sharing
   * page can say so instead of offering changes that will not stick.
   */
  bootstrap: boolean
}

/** What Google's ID token says about who signed in. */
export interface Profile {
  firstName: string | null
  lastName: string | null
}

/** Long enough for any real name, short enough not to be a place to hide text. */
const MAX_NAME = 80

/** Trims, caps the length, and treats blank as absent. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, MAX_NAME)
  return trimmed === '' ? null : trimmed
}

/** "Jane Smith", or null when neither name is known. */
export function displayName(viewer: {
  first_name: string | null
  last_name: string | null
}): string | null {
  const full = [viewer.first_name, viewer.last_name].filter(Boolean).join(' ').trim()
  return full === '' ? null : full
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
 * Whether this address is an owner because of the environment rather than a
 * decision anyone made in the app.
 *
 * Worth knowing before offering to change it: the seeding in listViewers and the
 * promotion in recordSignIn both re-assert the role, so removing or demoting one
 * of these addresses succeeds against the database and is undone on the next
 * page load. That is the point of the bootstrap — it is why losing owner access
 * cannot lock everybody out — but a button that appears to work and silently
 * reverts is worse than one that says it cannot.
 */
export function isBootstrapOwner(email: string): boolean {
  return bootstrapOwners().includes(normalizeEmail(email))
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
 *
 * `newRequest` says a pending row was created by this call rather than already
 * existing — the one moment worth emailing the owners about. It is deliberately
 * derived from the insert itself rather than from a prior lookup, so two
 * simultaneous sign-ins cannot both decide they were first.
 */
export async function recordSignIn(
  email: string,
  profile: Profile = { firstName: null, lastName: null },
): Promise<{
  role: Role
  emailPref: EmailPref
  newRequest: boolean
}> {
  await ensureSchema()
  const sql = db()
  const address = normalizeEmail(email)
  const firstName = cleanName(profile.firstName)
  const lastName = cleanName(profile.lastName)

  let newRequest = false

  if (bootstrapOwners().includes(address)) {
    await sql`
      insert into viewers (email, role, granted_by, first_name, last_name)
      values (${address}, 'owner', 'bootstrap', ${firstName}, ${lastName})
      on conflict (email) do update set role = 'owner', updated_at = now()
    `
  } else {
    const inserted = (await sql`
      insert into viewers (email, role, first_name, last_name)
      values (${address}, 'pending', ${firstName}, ${lastName})
      on conflict (email) do nothing
      returning email
    `) as unknown as { email: string }[]
    newRequest = inserted.length > 0
  }

  // Fill in a name Google knows and we do not. Per column and only where it is
  // blank, so an owner who corrects a name on the sharing page does not have it
  // silently reverted the next time that person signs in. The where clause makes
  // this a no-op on every sign-in after the first.
  if (firstName || lastName) {
    await sql`
      update viewers
         set first_name = case when coalesce(first_name, '') = '' then ${firstName} else first_name end,
             last_name  = case when coalesce(last_name, '')  = '' then ${lastName}  else last_name  end
       where email = ${address}
         and (coalesce(first_name, '') = '' or coalesce(last_name, '') = '')
    `
  }

  const rows = (await sql`
    select role, email_pref from viewers where email = ${address}
  `) as unknown as { role: string; email_pref: string }[]

  return {
    role: isRole(rows[0]?.role) ? rows[0].role : 'pending',
    emailPref: isEmailPref(rows[0]?.email_pref) ? rows[0].email_pref : 'daily',
    newRequest,
  }
}

/** Everyone who can grant access — the people to tell when somebody asks. */
export async function ownerEmails(): Promise<string[]> {
  await ensureSchema()
  const rows = (await db()`
    select email from viewers where role = 'owner' order by email
  `) as unknown as { email: string }[]
  return rows.map((r) => r.email)
}

/**
 * Sets or clears the name on one address, as typed by an owner.
 *
 * Nulls are a legitimate value: clearing a name Google guessed badly should be
 * possible, and leaves the row showing just the address as it did before.
 */
export async function setName(
  email: string,
  firstName: string | null,
  lastName: string | null,
): Promise<boolean> {
  await ensureSchema()
  const sql = db()
  // An update rather than an upsert: naming somebody should not be a way to
  // create them. Whether it matched is returned so a typo in an address is an
  // error the owner sees, not a save that quietly went nowhere.
  const rows = (await sql`
    update viewers
       set first_name = ${cleanName(firstName)},
           last_name = ${cleanName(lastName)},
           updated_at = now()
     where email = ${normalizeEmail(email)}
     returning email
  `) as unknown as { email: string }[]
  return rows.length > 0
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

  const rows = (await sql`
    select email, role, email_pref, first_name, last_name, created_at, updated_at, granted_by
    from viewers
    order by
      case role when 'pending' then 0 when 'owner' then 1 else 2 end,
      created_at desc
  `) as unknown as Omit<Viewer, 'bootstrap'>[]

  // Computed here rather than stored: the env var can change between deploys,
  // and a column would go stale the moment it did.
  return rows.map((row) => ({ ...row, bootstrap: isBootstrapOwner(row.email) }))
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
