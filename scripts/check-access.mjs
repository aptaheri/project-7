/**
 * Runs the access-request flow against a real Postgres.
 *
 * The parts worth pinning down are all rules rather than queries, and every one
 * of them is the kind that looks obviously right and is wrong in production:
 *
 *   - a name Google supplies must not overwrite one an owner typed
 *   - the owners are told once when somebody asks, not on every poll afterwards
 *   - naming somebody must not be a way to create or promote them
 *
 * Resend is stubbed, so this needs no API key and sends no mail.
 *
 *   npm run check-access
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()

const OIDS = { int: 20, float: 701, bool: 16, text: 25, textArray: 1009 }

function oidFor(value) {
  if (value === null) return OIDS.text
  if (typeof value === 'boolean') return OIDS.bool
  if (typeof value === 'number') return Number.isInteger(value) ? OIDS.int : OIDS.float
  if (Array.isArray(value)) return OIDS.textArray
  return OIDS.text
}

function tagged(strings, ...values) {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
    '',
  )
  return pg
    .query(text, values, { paramTypes: values.map(oidFor) })
    .then((r) => r.rows)
}

const dir = 'node_modules/.p7-sql-check'
mkdirSync(dir, { recursive: true })

// ensureSchema is the real one here, not a shim: the columns these tests depend
// on are added by it, and a deploy that forgot them is exactly the failure this
// file should catch.
const shimPath = resolve(dir, 'db-shim-access.mjs')
writeFileSync(shimPath, `
export function db() { return globalThis.__pg }
export async function ensureSchema() { await globalThis.__ensureSchema() }
`)

process.env.TRACK_OWNER_EMAILS = 'boss@example.com'
process.env.RESEND_API_KEY = 'test-key-not-used'
process.env.SESSION_SECRET = 'test-secret-for-access-check'

async function bundle(entry, outfile, swapDb = true) {
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    external: ['tz-lookup'],
    plugins: swapDb
      ? [
          {
            name: 'swap-db',
            setup(build) {
              build.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath }))
            },
          },
        ]
      : [],
  })
  const out = join(dir, outfile)
  writeFileSync(out, built.outputFiles[0].text)
  return import(pathToFileURL(resolve(out)).href)
}

globalThis.__pg = tagged

// db.mts cannot run here — it insists on a connection string — so the schema is
// applied the way that file applies it, in the same two steps.
globalThis.__ensureSchema = async () => {
  if (globalThis.__schemaDone) return
  globalThis.__schemaDone = true
  await pg.exec(`
    create table if not exists viewers (
      email      text primary key,
      role       text not null default 'pending',
      email_pref text not null default 'daily',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      granted_by text
    );
  `)
  // Deliberately created WITHOUT the name columns, then added the way db.mts
  // adds them to the table that already exists in production. If those alters
  // were ever dropped from ensureSchema, everything below would fail.
  await pg.exec(`
    alter table viewers add column if not exists first_name text;
    alter table viewers add column if not exists last_name text;
  `)
}
const users = await bundle('netlify/lib/users.mts', 'users-access.mjs')
const { buildAccessRequestEmail } = await bundle(
  'netlify/lib/access-email.mts',
  'access-email.mjs',
  false,
)

// Resend, stubbed. Records what would have been sent.
const sentMail = []
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.resend.com')) throw new Error(`unexpected fetch: ${url}`)
  const body = JSON.parse(init.body)
  sentMail.push(...body)
  return new Response(JSON.stringify({ data: body.map((_, i) => ({ id: `id-${i}` })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
const mailer = await bundle('netlify/lib/mailer.mts', 'mailer-access.mjs', false)

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const row = async (email) =>
  (await pg.query('select * from viewers where email = $1', [email])).rows[0]

// ── A first sign-in is a request, and carries a name ─────────────────────────
const first = await users.recordSignIn('Jane.Doe@example.com', {
  firstName: 'Jane',
  lastName: 'Doe',
})
check('an unknown account lands as pending', first.role === 'pending', first.role)
check('the first sign-in is a new request', first.newRequest === true)

let jane = await row('jane.doe@example.com')
check('the name from Google is stored', jane.first_name === 'Jane' && jane.last_name === 'Doe',
  `${jane.first_name} ${jane.last_name}`)

// ── Signing in again is not a new request ───────────────────────────────────
const second = await users.recordSignIn('jane.doe@example.com', {
  firstName: 'Jane',
  lastName: 'Doe',
})
check('signing in again is not a new request', second.newRequest === false)

// ── An owner's edit survives the next sign-in ───────────────────────────────
await users.setName('jane.doe@example.com', 'Janey', 'Doe-Smith')
await users.recordSignIn('jane.doe@example.com', { firstName: 'Jane', lastName: 'Doe' })
jane = await row('jane.doe@example.com')
check(
  "a later sign-in does not overwrite the owner's spelling",
  jane.first_name === 'Janey' && jane.last_name === 'Doe-Smith',
  `${jane.first_name} ${jane.last_name}`,
)

// ── A name Google did not give gets filled in later ─────────────────────────
await users.recordSignIn('nameless@example.com', { firstName: null, lastName: null })
let nameless = await row('nameless@example.com')
check('a nameless account is still recorded', nameless.role === 'pending')
check('no name is stored when Google gives none', nameless.first_name === null)
await users.recordSignIn('nameless@example.com', { firstName: 'Sam', lastName: 'Reed' })
nameless = await row('nameless@example.com')
check('a name arriving later is filled in', nameless.first_name === 'Sam' && nameless.last_name === 'Reed',
  `${nameless.first_name} ${nameless.last_name}`)

// ── Half a name is filled without clobbering the other half ─────────────────
await users.setName('nameless@example.com', 'Sam', '')
await users.recordSignIn('nameless@example.com', { firstName: 'Samuel', lastName: 'Reed' })
nameless = await row('nameless@example.com')
check(
  'a blank half is filled and the kept half is left alone',
  nameless.first_name === 'Sam' && nameless.last_name === 'Reed',
  `${nameless.first_name} ${nameless.last_name}`,
)

// ── Naming is not a way to create or promote ─────────────────────────────────
const missing = await users.setName('ghost@example.com', 'No', 'Body')
check('naming an unknown address changes nothing', missing === false)
check('and creates no row', (await row('ghost@example.com')) === undefined)
const janeRole = (await row('jane.doe@example.com')).role
check('naming somebody leaves their role alone', janeRole === 'pending', janeRole)

// ── Clearing a name is allowed ──────────────────────────────────────────────
await users.setName('jane.doe@example.com', '', '')
jane = await row('jane.doe@example.com')
check('a name can be cleared', jane.first_name === null && jane.last_name === null,
  `${jane.first_name} / ${jane.last_name}`)

// ── Length is capped ────────────────────────────────────────────────────────
await users.setName('jane.doe@example.com', 'x'.repeat(500), 'y')
jane = await row('jane.doe@example.com')
check('an absurd name is truncated, not rejected', jane.first_name.length === 80,
  `${jane.first_name.length} chars`)

// ── Bootstrap owners ────────────────────────────────────────────────────────
const boss = await users.recordSignIn('boss@example.com', { firstName: 'Bo', lastName: 'Ss' })
check('a bootstrap owner is an owner', boss.role === 'owner', boss.role)
check('an owner signing in is never a request', boss.newRequest === false)
const owners = await users.ownerEmails()
check('owners are listable for notification', JSON.stringify(owners) === '["boss@example.com"]',
  JSON.stringify(owners))

// ── The list carries names ──────────────────────────────────────────────────
const list = await users.listViewers()
check('the sharing list includes names', 'first_name' in list[0] && 'last_name' in list[0],
  Object.keys(list[0]).join(', '))

// ── The notification itself ─────────────────────────────────────────────────
const built = buildAccessRequestEmail({
  name: 'Jane Doe',
  email: 'jane.doe@example.com',
  origin: 'https://project7.bike',
})
check('the subject names who asked', built.subject.includes('Jane Doe'), built.subject)
check('the body links to the sharing page', built.html.includes('/track/sharing'))
check('there is a plain text part', built.text.includes('jane.doe@example.com'))

const nameless2 = buildAccessRequestEmail({ name: null, email: 'x@y.com', origin: 'https://p' })
check('with no name the subject falls back to the address', nameless2.subject.includes('x@y.com'),
  nameless2.subject)

await mailer.sendBatch(
  owners.map((to) => ({ to, subject: built.subject, html: built.html, text: built.text })),
)
check('the notification reaches every owner', sentMail.length === 1 && sentMail[0].to[0] === 'boss@example.com',
  JSON.stringify(sentMail.map((m) => m.to)))
check(
  'an owner notification carries no unsubscribe header',
  sentMail[0].headers === undefined,
  JSON.stringify(sentMail[0].headers ?? null),
)

// And the daily email must still carry one.
sentMail.length = 0
await mailer.sendBatch([
  { to: 'a@b.com', subject: 's', html: 'h', text: 't', unsubscribeUrl: 'https://p/api/unsubscribe?t=1' },
])
check(
  'a subscription email still carries List-Unsubscribe',
  sentMail[0].headers?.['List-Unsubscribe'] === '<https://p/api/unsubscribe?t=1>',
  JSON.stringify(sentMail[0].headers ?? null),
)

console.log(failures === 0 ? '\nAll access checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
