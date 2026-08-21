/**
 * Runs the destination-fact path with the model stubbed.
 *
 * What cannot be checked here is the only thing that matters most — whether the
 * sentence the model writes is true. That needs a real key and a real search,
 * and it is why the prompt tells the model to return NONE when it is unsure.
 *
 * What can be checked is everything around it: that a hand-written fact always
 * wins, that nothing is generated twice, that NONE is treated as a clean "no
 * fact" rather than printed literally into forty inboxes, and that every way
 * this can fail leaves the email one line shorter instead of unsent.
 *
 *   npm run check-fact
 */
import { PGlite } from '@electric-sql/pglite'
import * as esbuild from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pg = new PGlite()

function tagged(strings, ...values) {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
    '',
  )
  return pg.query(text, values).then((r) => r.rows)
}

const dir = 'node_modules/.p7-sql-check'
mkdirSync(dir, { recursive: true })
const shimPath = resolve(dir, 'db-shim-fact.mjs')
writeFileSync(shimPath, `
export function db() { return globalThis.__pg }
export async function ensureSchema() {}
`)

await pg.exec(`
  create table destination_facts (
    destination text primary key,
    fact        text not null,
    model       text not null,
    created_at  timestamptz not null default now()
  );
`)
globalThis.__pg = tagged

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-used'

const bundle = await esbuild.build({
  entryPoints: ['netlify/lib/fact.mts'],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{ name: 'swap-db', setup(b) { b.onResolve({ filter: /db\.mts$/ }, () => ({ path: shimPath })) } }],
})
const outPath = join(dir, 'fact.mjs')
writeFileSync(outPath, bundle.outputFiles[0].text)
const { factFor } = await import(pathToFileURL(resolve(outPath)).href)

// The Messages API, stubbed. `reply` decides what this turn returns.
let calls = 0
let reply = { text: 'The Roman road from Toulouse crossed the river here.' }
globalThis.fetch = async (url) => {
  if (!String(url).includes('api.anthropic.com')) throw new Error(`unexpected fetch: ${url}`)
  calls++
  if (reply.throw) throw new Error('connection reset')
  if (reply.status) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }),
      { status: reply.status, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [{ type: 'text', text: reply.text }],
    stop_reason: reply.stop_reason ?? 'end_turn',
    stop_details: reply.stop_reason === 'refusal' ? { type: 'refusal', category: 'cyber' } : null,
    usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const stored = async (d) =>
  (await pg.query('select fact from destination_facts where destination = $1', [d])).rows[0]

// ── A hand-written fact is never overridden ─────────────────────────────────
calls = 0
const porto = await factFor('Porto')
check('a hand-written fact is used as written', porto?.startsWith('T'), porto?.slice(0, 40) + '…')
check('and costs no model call', calls === 0, `${calls} call(s)`)

// ── An unknown place is generated once, then remembered ─────────────────────
calls = 0
const first = await factFor('Solomiac')
check('an unknown place gets a generated line', first === reply.text, first)
check('which is stored', (await stored('Solomiac'))?.fact === reply.text)
const second = await factFor('Solomiac')
check('a repeat visit reuses it', second === first)
check('without asking the model again', calls === 1, `${calls} call(s)`)

// ── NONE means no line, and is never stored ─────────────────────────────────
reply = { text: 'NONE' }
const nothing = await factFor('Tiny Hamlet')
check('NONE becomes no fact at all', nothing === null, JSON.stringify(nothing))
check('and is not stored as a sentence', (await stored('Tiny Hamlet')) === undefined)

// A refusal to answer inside a sentence counts too — the email must never
// print the word NONE to forty people.
reply = { text: 'NONE — I could not verify anything about this village.' }
check('a wordy refusal is also no fact', (await factFor('Another Hamlet')) === null)

// ── Every failure mode costs a line, not the email ──────────────────────────
reply = { text: 'x'.repeat(600) }
check('an overlong answer is discarded', (await factFor('Rambling Place')) === null)
check('and not stored', (await stored('Rambling Place')) === undefined)

reply = { text: 'irrelevant', stop_reason: 'refusal' }
check('a model refusal is no fact', (await factFor('Refused Place')) === null)

reply = { status: 500 }
check('an API error is no fact', (await factFor('Broken Place')) === null)

reply = { throw: true }
check('a dropped connection is no fact', (await factFor('Offline Place')) === null)

// ── No key configured ───────────────────────────────────────────────────────
delete process.env.ANTHROPIC_API_KEY
calls = 0
check('with no key, no fact and no call', (await factFor('Keyless Place')) === null && calls === 0)

console.log(failures === 0 ? '\nAll fact checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
