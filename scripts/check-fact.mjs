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
const { factFor, ensureFact } = await import(pathToFileURL(resolve(outPath)).href)

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
  const blocks = reply.blocks ?? [reply.text]
  return new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: blocks.map((text) => ({ type: 'text', text })),
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

// ── The send path never generates ───────────────────────────────────────────
// The email has thirty seconds to send forty messages and writing a line takes
// thirteen to twenty-five of them. This is the assertion that keeps it out.
calls = 0
check('an unwarmed place is simply blank at send time', (await factFor('Nowhere Yet')) === null)
check('and costs no model call', calls === 0, `${calls} call(s)`)

// ── A hand-written fact is never overridden ─────────────────────────────────
calls = 0
const porto = await factFor('Porto')
check('a hand-written fact is used as written', porto?.startsWith('T'), porto?.slice(0, 40) + '…')
check('and costs no model call', calls === 0, `${calls} call(s)`)
check('warming a hand-written place does nothing', (await ensureFact('Porto')) === 'curated')

// ── Warming writes once, then remembers ─────────────────────────────────────
calls = 0
check('an unknown place gets written', (await ensureFact('Solomiac')) === 'written')
check('which is stored', (await stored('Solomiac'))?.fact === reply.text)
check('and is what the send reads', (await factFor('Solomiac')) === reply.text)
check('warming again is a no-op', (await ensureFact('Solomiac')) === 'stored')
check('so the model is asked exactly once', calls === 1, `${calls} call(s)`)

// A run that has used its one write skips the rest for the next run.
check('writing can be withheld', (await ensureFact('Held Back', false)) === 'skipped')
check('and nothing is stored for it', (await stored('Held Back')) === undefined)

// ── Only the last text block is the answer ──────────────────────────────────
// With a search tool the model narrates before it searches. One real answer
// began "I'll search for information about Rieupeyroux." — joining the blocks
// would have emailed the narration.
reply = { blocks: ['I\'ll search for information about this place.', 'The bastide was founded in 1332.'] }
check('narration before the search is dropped', (await ensureFact('Narrated Place')) === 'written')
check('and only the answer is kept', (await stored('Narrated Place'))?.fact === 'The bastide was founded in 1332.')

// ── Citation whitespace is tidied ───────────────────────────────────────────
// Answers come back spaced around inline citations: "around  849 metres , sits".
reply = { text: 'Tence sits at  849 metres , on a plateau.' }
await ensureFact('Spaced Place')
check('citation spacing is cleaned up',
  (await stored('Spaced Place'))?.fact === 'Tence sits at 849 metres, on a plateau.',
  (await stored('Spaced Place'))?.fact)

// ── NONE means no line, and is never stored ─────────────────────────────────
reply = { text: 'NONE' }
check('NONE is a decline, not a sentence', (await ensureFact('Tiny Hamlet')) === 'declined')
check('and is not stored', (await stored('Tiny Hamlet')) === undefined)
check('and the email opens without a line', (await factFor('Tiny Hamlet')) === null)

reply = { text: 'NONE — I could not verify anything about this village.' }
check('a wordy refusal is also a decline', (await ensureFact('Another Hamlet')) === 'declined')

// ── Failing and declining are told apart ────────────────────────────────────
// A decline is permanent and fine; a failure is worth retrying next run, and a
// log that calls a timeout a decline hides an outage.
reply = { text: 'x'.repeat(600) }
check('an overlong answer is discarded', (await ensureFact('Rambling Place')) === 'declined')
check('and not stored', (await stored('Rambling Place')) === undefined)

reply = { text: 'irrelevant', stop_reason: 'refusal' }
check('a model refusal is a decline', (await ensureFact('Refused Place')) === 'declined')

reply = { status: 500 }
check('an API error is a failure', (await ensureFact('Broken Place')) === 'failed')

reply = { throw: true }
check('a dropped connection is a failure', (await ensureFact('Offline Place')) === 'failed')

// ── No key configured ───────────────────────────────────────────────────────
delete process.env.ANTHROPIC_API_KEY
calls = 0
check('with no key it fails without calling', (await ensureFact('Keyless Place')) === 'failed' && calls === 0)
check('and the send still reads cleanly', (await factFor('Keyless Place')) === null)

console.log(failures === 0 ? '\nAll fact checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
