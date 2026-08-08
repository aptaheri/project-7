import { db, ensureSchema } from './db.mts'
import type { Role } from './session.mts'

export interface Viewer {
  email: string
  role: Role
  created_at: string
  updated_at: string
  granted_by: string | null
}

export const ROLES: Role[] = ['owner', 'viewer', 'pending']

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
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Records a Google sign-in and returns the caller's role.
 *
 * Unknown emails land as 'pending' so an owner can see who asked without
 * having to know the address in advance. Bootstrap owners are promoted on
 * every sign-in, so losing owner access cannot lock everyone out.
 */
export async function recordSignIn(email: string): Promise<Role> {
  await ensureSchema()
  const sql = db()
  const address = email.toLowerCase()

  if (bootstrapOwners().includes(address)) {
    await sql`
      insert into viewers (email, role, granted_by)
      values (${address}, 'owner', 'bootstrap')
      on conflict (email) do update set role = 'owner', updated_at = now()
    `
    return 'owner'
  }

  await sql`
    insert into viewers (email, role)
    values (${address}, 'pending')
    on conflict (email) do nothing
  `
  const rows = (await sql`
    select role from viewers where email = ${address}
  `) as unknown as { role: string }[]

  const role = rows[0]?.role
  return isRole(role) ? role : 'pending'
}

export async function listViewers(): Promise<Viewer[]> {
  await ensureSchema()
  const sql = db()
  return (await sql`
    select email, role, created_at, updated_at, granted_by
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
    values (${email.toLowerCase()}, ${role}, ${grantedBy})
    on conflict (email) do update
      set role = ${role}, granted_by = ${grantedBy}, updated_at = now()
  `
}

export async function removeViewer(email: string): Promise<void> {
  await ensureSchema()
  const sql = db()
  await sql`delete from viewers where email = ${email.toLowerCase()}`
}
