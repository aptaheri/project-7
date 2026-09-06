/**
 * Runs the destination-line path with the model stubbed.
 *
 * What cannot be checked here is the thing that matters most — whether what the
 * model writes is true. That needs a real key and a real search, and it is why
 * the brief tells it to return an empty string when it is unsure.
 *
 * What can be checked is everything around it: that a hand-written fact always
 * wins, that nothing is generated twice, that a line written to an older brief
 * is replaced, that the distance sentence is optional in a way the fact is not,
 * and that every way this can fail leaves the email shorter rather than unsent.
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
    destination    text primary key,
    fact           text,
    distance_line  text,
    distance_miles double precision,
    model          text not null,
    format_version int not null default 1,
    attempts       int not null default 0,
    declined_at    timestamptz,
    created_at     timestamptz not null default now()
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
const { factFor, ensureFact, FORMAT_VERSION } = await import(pathToFileURL(resolve(outPath)).href)

// The Messages API, stubbed. `reply` decides what this turn returns; the model
// answers in JSON because the request pins a schema.
let calls = 0
let lastPrompt = ''
let reply = { fact: 'A bastide founded in 1332. Its market hall still stands.', distance: 'Today is four times the length of the valley below.' }
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.anthropic.com')) throw new Error(`unexpected fetch: ${url}`)
  calls++
  lastPrompt = JSON.parse(init.body).messages[0].content
  if (reply.throw) throw new Error('connection reset')
  if (reply.status) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }),
      { status: reply.status, headers: { 'content-type': 'application/json' } })
  }
  const answer = reply.raw ?? JSON.stringify({ fact: reply.fact ?? '', ride: reply.distance ?? '' })
  const blocks = reply.narrate ? [reply.narrate, answer] : [answer]
  return new Response(JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: blocks.map((text) => ({ type: 'text', text })),
    stop_reason: reply.stop_reason ?? 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const row = async (d) =>
  (await pg.query('select * from destination_facts where destination = $1', [d])).rows[0]

// ── The send path never generates ───────────────────────────────────────────
// The email has thirty seconds to send forty messages; writing takes most of
// that. This is the assertion that keeps generation out of it.
calls = 0
const blank = await factFor('Nowhere Yet')
check('an unwarmed place is blank at send time', blank.fact === null && blank.distance === null)
check('and costs no model call', calls === 0, `${calls} call(s)`)

// ── A hand-written fact is never overridden ─────────────────────────────────
calls = 0
const porto = await factFor('Porto')
check('a hand-written fact is used as written', porto.fact?.startsWith('T'), porto.fact?.slice(0, 40) + '…')
check('and has no distance line, so arithmetic covers it', porto.distance === null)
check('reading it costs no model call', calls === 0, `${calls} call(s)`)

// A hand-written place still gets a distance sentence written about it — that
// is the only way those mornings get one, since the fact itself never changes.
reply = { fact: 'IGNORED — the model was told to leave this empty', distance: 'Today is four times the length of the Douro gorge.' }
check('a hand-written place gets a distance line', (await ensureFact('Porto', 62)) === 'written')
check('and the model is shown the fact it must not repeat',
  lastPrompt.includes('already written'), 'distance-only brief')
const portoRow = await row('Porto')
check('the line is stored', portoRow?.distance_line === reply.distance)
check('the hand-written fact is what the send reads',
  (await factFor('Porto')).fact?.startsWith('The port wine'))
check('alongside the written line', (await factFor('Porto')).distance === reply.distance)
check('and it is not asked twice', (await ensureFact('Porto', 62)) === 'stored')

reply = { fact: '', distance: '' }
check('no usable line for a hand-written place is a decline',
  (await ensureFact('Nazaré', 40)) === 'declined')
check('and its fact still reads fine', (await factFor('Nazaré')).fact !== null)

reply = { fact: 'A bastide founded in 1332. Its market hall still stands.', distance: 'Today is four times the length of the valley below.' }

// ── Warming writes both pieces, once ────────────────────────────────────────
calls = 0
check('an unknown place gets written', (await ensureFact('Solomiac', 88)) === 'written')
const solomiac = await row('Solomiac')
check('the fact is stored', solomiac?.fact === reply.fact)
check('so is the distance line', solomiac?.distance_line === reply.distance)
check('stamped with the current brief', solomiac?.format_version === FORMAT_VERSION)
check('the day\'s mileage reaches the model', lastPrompt.includes('88 miles'), '88 miles / 142 km')
const read = await factFor('Solomiac')
check('and both come back at send time', read.fact === reply.fact && read.distance === reply.distance)
check('warming again is a no-op', (await ensureFact('Solomiac', 88)) === 'stored')
check('so the model is asked exactly once', calls === 1, `${calls} call(s)`)

// A run that has used its one write leaves the rest for the next run.
check('writing can be withheld', (await ensureFact('Held Back', 40, false)) === 'skipped')
check('and nothing is stored for it', (await row('Held Back')) === undefined)

// ── A line written to an older brief is replaced ────────────────────────────
await pg.query(
  `insert into destination_facts (destination, fact, model, format_version)
   values ('Stale Place', 'One old sentence.', 'claude-opus-5', $1)`,
  [FORMAT_VERSION - 1],
)
reply = { fact: 'Two new sentences. With more in them.', distance: 'A local comparison.' }
check('an outdated line is rewritten', (await ensureFact('Stale Place', 50)) === 'written')
check('with the new text', (await row('Stale Place'))?.fact === reply.fact)
check('and the new version', (await row('Stale Place'))?.format_version === FORMAT_VERSION)

// ── Narration before the search is dropped ──────────────────────────────────
// One real answer began "I'll search for information about Rieupeyroux."
reply = { fact: 'The church was fortified in 1356.', distance: '', narrate: "I'll search for this place." }
check('narration is not mistaken for the answer', (await ensureFact('Narrated Place', 30)) === 'written')
check('and only the answer is kept', (await row('Narrated Place'))?.fact === reply.fact)

// ── The distance sentence is optional; the fact is not ──────────────────────
reply = { fact: 'A real fact about a real place.', distance: '' }
check('a fact with no distance line is kept', (await ensureFact('No Compare', 70)) === 'written')
check('and stores null for the line', (await row('No Compare'))?.distance_line === null)
const noCompare = await factFor('No Compare')
check('so the send falls back to arithmetic', noCompare.fact !== null && noCompare.distance === null)

reply = { fact: 'A real fact.', distance: 'x'.repeat(300) }
check('an overlong distance line is dropped', (await ensureFact('Rambling Compare', 70)) === 'written')
check('but its fact survives', (await row('Rambling Compare'))?.fact === 'A real fact.')
check('with no line', (await row('Rambling Compare'))?.distance_line === null)

reply = { fact: '', distance: 'A comparison with nothing to compare.' }
check('an empty fact is a decline', (await ensureFact('Tiny Hamlet', 70)) === 'declined')
// A row is written, but it holds the record of having tried rather than a fact.
check('leaving a marker, not a fact', (await row('Tiny Hamlet'))?.fact === null)
check('and the send reads it as blank', (await factFor('Tiny Hamlet')).fact === null)

reply = { fact: 'x'.repeat(1200), distance: 'fine' }
check('an overlong fact is a decline', (await ensureFact('Rambling Place', 70)) === 'declined')
check('and no fact is stored for it', (await row('Rambling Place'))?.fact === null)

// ── Failing and declining are told apart ────────────────────────────────────
// A decline is permanent and fine; a failure is worth retrying next run, and a
// log that calls a timeout a decline hides an outage.
reply = { raw: 'not json at all' }
check('an unparseable answer is a decline', (await ensureFact('Garbled Place', 70)) === 'declined')

reply = { fact: 'irrelevant', stop_reason: 'refusal' }
check('a model refusal is a decline', (await ensureFact('Refused Place', 70)) === 'declined')

reply = { status: 500 }
check('an API error is a failure', (await ensureFact('Broken Place', 70)) === 'failed')

reply = { throw: true }
check('a dropped connection is a failure', (await ensureFact('Offline Place', 70)) === 'failed')

// ── An unknown distance still gets a fact ───────────────────────────────────
reply = { fact: 'A fact about a rest day town.', distance: '' }
calls = 0
check('a place with no mileage is still warmed', (await ensureFact('Rest Day Town', null)) === 'written')
check('and the model is told the distance is unknown',
  lastPrompt.includes('distance unknown'), 'distance unknown')

// ── A changed distance rewrites the sentence about it ──────────────────────
// The line is written about a number — "today's 114 km covered more than a
// third of the Stevenson Trail". When John corrects a day's distance the fact
// stays true and that sentence quietly becomes wrong.
reply = { fact: 'A place with a fact. And a second sentence.', distance: 'Eighty miles is twice the lake.' }
check('a day is warmed at 80 miles', (await ensureFact('Corrected Place', 80)) === 'written')
check('recording the distance it was written about',
  (await row('Corrected Place'))?.distance_miles === 80)
check('the same distance is a no-op', (await ensureFact('Corrected Place', 80)) === 'stored')

calls = 0
reply = { fact: 'IGNORED', distance: 'Sixty miles is one and a half lakes.' }
check('a corrected distance is rewritten', (await ensureFact('Corrected Place', 60)) === 'written')
check('with a new sentence', (await row('Corrected Place'))?.distance_line === reply.distance)
check('about the new number', (await row('Corrected Place'))?.distance_miles === 60)
check('and the fact it already had is kept, not rewritten',
  (await row('Corrected Place'))?.fact === 'A place with a fact. And a second sentence.')
check('the model was shown that fact rather than asked for a new one',
  lastPrompt.includes('already written'), 'distance-only brief')
check('one call, not two', calls === 1, `${calls} call(s)`)

// A rounding difference is not a correction.
check('a trivial difference is ignored', (await ensureFact('Corrected Place', 60.4)) === 'stored')

// ── Tried, and given up on ─────────────────────────────────────────────────
// An empty answer is the brief working, but nothing was stored when it
// happened, so the same village was re-asked every run at two cents a time.
reply = { fact: '', distance: '' }
calls = 0
check('a decline is recorded', (await ensureFact('Hopeless Hamlet', 40)) === 'declined')
check('as a row with no fact', (await row('Hopeless Hamlet'))?.fact === null)
check('counting the attempt', (await row('Hopeless Hamlet'))?.attempts === 1)
check('and stamped with when it gave up', (await row('Hopeless Hamlet'))?.declined_at !== null)

check('a second refusal counts too', (await ensureFact('Hopeless Hamlet', 40)) === 'declined')
check('a third as well', (await ensureFact('Hopeless Hamlet', 40)) === 'declined')
check('three attempts recorded', (await row('Hopeless Hamlet'))?.attempts === 3)
check('the model was asked three times', calls === 3, `${calls} call(s)`)

calls = 0
check('the fourth run does not ask', (await ensureFact('Hopeless Hamlet', 40)) === 'exhausted')
check('and spends nothing', calls === 0, `${calls} call(s)`)
check('the send still reads it as blank', (await factFor('Hopeless Hamlet')).fact === null)

// The row must not consume a run's single attempt either — the whole point is
// that it stops costing anything.
check('nor does it use the run\'s one attempt',
  (await ensureFact('Hopeless Hamlet', 40, false)) === 'exhausted')

// A new brief is a different question, so everything given up on is revived.
await pg.query(
  `update destination_facts set format_version = $1 where destination = 'Hopeless Hamlet'`,
  [FORMAT_VERSION - 1],
)
reply = { fact: 'It turns out there was something after all. Two sentences of it.', distance: 'A line.' }
calls = 0
check('a newer brief revives a given-up place',
  (await ensureFact('Hopeless Hamlet', 40)) === 'written')
check('which asks the model again', calls === 1, `${calls} call(s)`)
check('and clears the refusals', (await row('Hopeless Hamlet'))?.attempts === 0)
check('and the record of giving up', (await row('Hopeless Hamlet'))?.declined_at === null)

// ── No key configured ───────────────────────────────────────────────────────
delete process.env.ANTHROPIC_API_KEY
calls = 0
check('with no key it fails without calling', (await ensureFact('Keyless Place', 70)) === 'failed' && calls === 0)
const keyless = await factFor('Keyless Place')
check('and the send still reads cleanly', keyless.fact === null && keyless.distance === null)

console.log(failures === 0 ? '\nAll fact checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
