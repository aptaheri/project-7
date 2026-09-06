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
  // Sign-in for people on neither Google nor Microsoft. Hashed tokens, so a
  // leaked table is not a set of live sessions.
  await pg.exec(`
    create table if not exists magic_link_tokens (
      token_hash text primary key,
      email      text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at    timestamptz
    );
    create table if not exists auth_identities (
      provider   text not null,
      subject    text not null,
      email      text not null,
      first_name text,
      last_name  text,
      created_at timestamptz not null default now(),
      last_seen  timestamptz not null default now(),
      primary key (provider, subject)
    );
  `)
  await pg.exec(`alter table viewers add column if not exists last_provider text;`)

  // The route editor's table, so its gate can be exercised here alongside
  // every other question of who may do what.
  await pg.exec(`
    create table if not exists route_days (
      date date primary key, kind text not null,
      from_place text, to_place text, miles double precision, note text,
      from_lon double precision, from_lat double precision,
      to_lon double precision, to_lat double precision,
      cycling_miles double precision, route_coords jsonb,
      needs_review boolean not null default false,
      updated_by text, updated_at timestamptz not null default now()
    );
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
// Everyone else the site knows about, so the next assertion means what it says:
// the notification list excludes viewers and pending requests rather than
// happening to contain one address because there is only one row.
await pg.query(`insert into viewers (email, role) values ('sees@example.com', 'viewer')
                on conflict (email) do update set role = 'viewer'`)
await pg.query(`insert into viewers (email, role) values ('waiting@example.com', 'pending')
                on conflict (email) do update set role = 'pending'`)
const everyone = (await pg.query('select email, role from viewers order by email')).rows
check('the fixture holds owners, a viewer and pending accounts',
  everyone.length >= 4 && everyone.some((v) => v.role === 'viewer') &&
    everyone.some((v) => v.role === 'pending'),
  everyone.map((v) => `${v.email}:${v.role}`).join(', '))

const owners = await users.ownerEmails()
check('only owners are told about an access request',
  JSON.stringify(owners) === '["boss@example.com"]',
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

// ── Who may change the route ───────────────────────────────────────────────
// This endpoint decides what forty people are told every morning, and it is the
// one place a non-owner could rewrite the trip. Both verbs are checked: the
// gate sits above the method branch, and a later refactor that moves it below
// would leave reads open while the tests still passed on writes.
const routeFn = await bundle('netlify/functions/route.mts', 'route-access.mjs')
const { createSession } = await bundle('netlify/lib/session.mts', 'session-access.mjs', false)

await pg.query(`insert into route_days (date, kind, to_place)
                values ('2026-08-24', 'ride', 'Aubenas')
                on conflict (date) do nothing`)

const asUser = (email) => {
  const { value } = createSession(email)
  return { cookie: `p7_session=${encodeURIComponent(value)}` }
}

const callRoute = async (method, headers) => {
  const init = { method, headers: { ...headers } }
  if (method === 'POST') {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      kind: 'ride', to: 'Somewhere Else', toCoords: [4.0, 45.0], miles: 50, note: '',
    })
  }
  const res = await routeFn.default(new Request('https://project7.bike/api/route', init))
  return res.status
}

for (const method of ['GET', 'POST']) {
  check(`${method} is refused with no session`, (await callRoute(method, {})) === 401)
  check(`${method} is refused for a pending account`,
    (await callRoute(method, asUser('jane@example.com'))) === 403)
}

// A viewer can watch the tracker and still may not rewrite the trip.
await pg.query(`insert into viewers (email, role) values ('watcher@example.com', 'viewer')
                on conflict (email) do update set role = 'viewer'`)
for (const method of ['GET', 'POST']) {
  check(`${method} is refused for a viewer`,
    (await callRoute(method, asUser('watcher@example.com'))) === 403)
}

// And an owner can.
check('GET is allowed for an owner', (await callRoute('GET', asUser('boss@example.com'))) === 200)

// A forged cookie is not a session.
check('a tampered cookie is refused',
  (await callRoute('GET', { cookie: 'p7_session=boss%40example.com.notasignature' })) === 401)
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

// ── A bootstrap owner cannot be removed or demoted ──────────────────────────
// The role is re-asserted on every page load and every sign-in, so a delete
// that "works" comes straight back with the name blanked. The list says which
// rows those are; refusing the change is the sharing page's job.
check('a bootstrap owner is flagged in the list',
  (await users.listViewers()).find((v) => v.email === 'boss@example.com')?.bootstrap === true)
check('an ordinary row is not flagged',
  (await users.listViewers()).find((v) => v.email === 'nameless@example.com')?.bootstrap === false)
check('the env var is what decides', users.isBootstrapOwner('BOSS@example.com') === true)
check('and it is not everyone', users.isBootstrapOwner('nameless@example.com') === false)

// Proving the reason it must be refused: deleting one and listing again brings
// it back, which is exactly the confusing behaviour being prevented.
await users.removeViewer('boss@example.com')
check('a bootstrap owner deleted at the database level reappears on the next list',
  (await users.listViewers()).some((v) => v.email === 'boss@example.com'))

// ── A magic link is possession of an address, and nothing more ─────────────
// This is the one method whose proof is stronger than the token it replaces:
// Google's carries email_verified and Microsoft's carries nothing of the kind,
// but clicking a link delivered to an address is possession of that address.
// Everything below is about it staying that narrow.
const magic = await bundle('netlify/lib/magic.mts', 'magic.mjs')

const link = await magic.issueLink('Someone@Example.com  ')
check('a link is minted for an address', typeof link.token === 'string' && link.token.length > 30,
  `${link.token.length} chars`)

// The row is a record that a link exists, not the link itself.
const stored = await pg.query('select token_hash, email from magic_link_tokens')
check('the token is never stored in the clear',
  !stored.rows.some((r) => r.token_hash === link.token))
check('only its hash is', stored.rows[0].token_hash.length === 64, stored.rows[0].token_hash.length)
check('and the address is normalised on the way in',
  stored.rows[0].email === 'someone@example.com', stored.rows[0].email)

const good = await magic.redeemLink(link.token)
check('redeeming it returns the address it was sent to',
  good.ok === true && good.email === 'someone@example.com', JSON.stringify(good))

// The property the whole thing rests on: one click, once.
const again = await magic.redeemLink(link.token)
check('a second click is refused', again.ok === false, JSON.stringify(again))
check('and says so, rather than pretending the link never existed',
  again.ok === false && again.reason === 'used', again.ok === false ? again.reason : '')

// A token nobody issued is not a way in, and does not look different from one
// that has expired.
const forged = await magic.redeemLink('not-a-token-anybody-issued')
check('an unissued token is refused', forged.ok === false && forged.reason === 'unknown',
  forged.ok === false ? forged.reason : '')

// Expiry is enforced in the statement that spends it, not by a later sweep.
const stale = await magic.issueLink('stale@example.com')
await pg.query(`update magic_link_tokens set expires_at = now() - interval '1 minute'
                where email = 'stale@example.com'`)
const dead = await magic.redeemLink(stale.token)
check('an expired link is refused', dead.ok === false && dead.reason === 'expired',
  dead.ok === false ? dead.reason : '')

// The one that would be catastrophic and would look fine in a demo: a link
// minted for one address must never come back holding another.
const mine = await magic.issueLink('viewer@example.com')
const theirs = await magic.issueLink('attacker@example.com')
const redeemed = await magic.redeemLink(theirs.token)
check('a link redeems as its own address, never a neighbour',
  redeemed.ok === true && redeemed.email === 'attacker@example.com',
  redeemed.ok === true ? redeemed.email : '')
const stillMine = await magic.redeemLink(mine.token)
check('and spending one leaves the other alone',
  stillMine.ok === true && stillMine.email === 'viewer@example.com',
  stillMine.ok === true ? stillMine.email : '')

// Asking twice does not invalidate the copy already on its way — the first
// email to arrive is often the second one sent.
const askedOnce = await magic.issueLink('twice@example.com')
const askedAgain = await magic.issueLink('twice@example.com')
check('a second request does not kill the first link',
  (await magic.redeemLink(askedOnce.token)).ok === true)
check('and the newer one still works too',
  (await magic.redeemLink(askedAgain.token)).ok === true)

// Spent rows are kept a while, which is what lets a second click be explained
// rather than denied. The sweep is what stops that being forever.
const swept = await magic.sweepLinks(0)
check('the sweep clears links that have had their day', swept > 0, `${swept} row(s)`)
check('and leaves the table empty when they all have',
  (await pg.query('select count(*)::int as n from magic_link_tokens')).rows[0].n === 0)

// ── An identity is what gets access, not an address ────────────────────────
// The reason this exists: the app accepts Microsoft tokens from any tenant,
// because every university is its own. Microsoft lets a tenant set a user's
// email attribute to anything and signs no email_verified claim, so a token
// bearing a viewer's address is a claim. Binding is what turns a proved
// address into access, and nothing else may.
const ident = await bundle('netlify/lib/identity.mts', 'identity.mjs')

await pg.query(`insert into viewers (email, role) values ('bound@example.com', 'viewer')
                on conflict (email) do nothing`)

check('an unbound identity owns no address',
  (await ident.boundEmail('microsoft', 'tenant-a:user-1')) === null)

await ident.bindIdentity({
  provider: 'microsoft', subject: 'tenant-a:user-1',
  email: 'bound@example.com', firstName: 'Bound', lastName: 'Person',
})
check('once bound it owns that one',
  (await ident.boundEmail('microsoft', 'tenant-a:user-1')) === 'bound@example.com')

// The attack, stated plainly: somebody else's tenant, claiming the same
// address. It is a different subject, so it is a different identity, and it
// inherits nothing.
check('a different tenant claiming the same address is a stranger',
  (await ident.boundEmail('microsoft', 'tenant-evil:user-1')) === null)
check('and so is the same user id in a different tenant',
  (await ident.boundEmail('microsoft', 'tenant-b:user-1')) === null)

// Providers are separate namespaces: a Google sub is not a Microsoft oid even
// if the strings ever collided.
check('providers do not share subjects',
  (await ident.boundEmail('google', 'tenant-a:user-1')) === null)

// Rebinding follows a person who changes address rather than stranding them.
await ident.bindIdentity({
  provider: 'microsoft', subject: 'tenant-a:user-1',
  email: 'moved@example.com', firstName: null, lastName: null,
})
check('a rebind moves the identity to the new address',
  (await ident.boundEmail('microsoft', 'tenant-a:user-1')) === 'moved@example.com')
const keptName = (await pg.query(
  `select first_name from auth_identities where provider='microsoft' and subject='tenant-a:user-1'`,
)).rows[0]
check('and keeps the name already on file', keptName.first_name === 'Bound', keptName.first_name)

// What worked last time is observed, never inferred from a mail domain — that
// was tried, and Cornell's MX says Microsoft while its people use Google.
await ident.rememberProvider('bound@example.com', 'microsoft')
check('the way in that worked is remembered',
  (await ident.lastProvider('bound@example.com')) === 'microsoft')
check('and is null for somebody who has never got in',
  (await ident.lastProvider('nobody@example.com')) === null)

console.log(failures === 0 ? '\nAll access checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
