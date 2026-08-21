import Anthropic from '@anthropic-ai/sdk'
import facts from '../../src/data/destination-facts.json'
import { db, ensureSchema } from './db.mts'

/**
 * One true line about tonight's destination, written when the email is sent.
 *
 * The hand-written table in destination-facts.json covers 33 of the 354 places
 * this trip stops at, so nine mornings in ten the email had no opening line.
 * Rather than write three hundred more by hand, the rest are generated — which
 * is a deliberate reversal of what that file's comment argues for, and John's
 * call: an unreviewed sentence about a town nobody has checked is exactly the
 * risk being accepted here.
 *
 * Three things keep that risk as small as it can be while still being taken:
 *
 *   - The model searches the web before answering, so the sentence is grounded
 *     in something written about the place rather than recalled about it. Most
 *     of these are villages of a few hundred people; recall alone would invent.
 *   - It is told to return nothing when it cannot verify, and nothing is what
 *     the email then prints. A missing line costs nothing; a wrong one costs
 *     trust with forty people who know him.
 *   - Everything generated is stored and logged, so a sentence that does turn
 *     out to be wrong can be found, corrected in the hand-written file, and
 *     never sent again.
 */

/** Hand-written facts win over anything generated, always. */
function curated(destination: string): string | null {
  const table = (facts as { facts: Record<string, string> }).facts
  return table[destination] ?? null
}

/**
 * How long one generation may take.
 *
 * Measured, not guessed: a search plus an answer takes about thirteen seconds,
 * and the first version of this timed out at twelve — which meant it produced
 * nothing at all, every time, while still spending the wait. It gets room now,
 * because it no longer runs anywhere that is in a hurry.
 *
 * No retries either. A retry does not shorten anything; it doubles the wall
 * clock, which is what turned a twelve-second timeout into a twenty-five second
 * one. The next scheduled run is the retry.
 */
const GENERATION_TIMEOUT_MS = 25_000

/** Long enough for a sentence and the thinking behind it, and no longer. */
const MAX_TOKENS = 4096

/** The model returns this exact word when it has nothing it can stand behind. */
const NOTHING = 'NONE'

const PROMPT = `You write one sentence for a daily email about a cycling expedition across seven continents. Tonight the rider arrives in the place named below.

Search the web, then write ONE sentence about that place that a reader would find genuinely interesting — history, geography, an industry, something that happened there. It is read by people who know the rider personally, so it must be true and specific to that exact place.

Rules:
- One sentence, under 40 words. No preamble, no quotes, no source list.
- It must be a fact about the place, not about cycling or the expedition.
- Do not describe it as charming, picturesque, quaint, or a hidden gem.
- No superlatives — only, first, oldest, largest, unique — unless a source says so plainly. A true fact with an invented "the only one ever" is a wrong fact, and it is the most likely way for you to be wrong here.
- If the search does not give you something you are confident is true and specific to this place, reply with exactly ${NOTHING}. Many of these are villages of a few hundred people; ${NOTHING} is a perfectly good answer and is much better than a plausible guess.

Place: `

interface Generated {
  fact: string
  model: string
}

/**
 * Failing and declining are different things and the log should say which.
 *
 * A decline is the model doing as it was told about a village it could not
 * verify; a failure is a timeout or an outage. The first is fine and permanent,
 * the second is worth retrying on the next run.
 */
type Attempt =
  | { type: 'written'; generated: Generated }
  | { type: 'declined' }
  | { type: 'failed' }

/**
 * Tidies what comes back.
 *
 * Answers arrive with the spacing left behind by inline citations — "around
 * 849 metres , sits" — which is invisible in a terminal and obvious in an
 * email.
 */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

/**
 * Asks Claude for a sentence, with the web available to check itself.
 *
 * Returns null on anything at all going wrong — no key, a refusal, a timeout, a
 * malformed answer. Every one of those means the email prints one line fewer,
 * which is a thing it already does most mornings.
 */
async function generate(destination: string): Promise<Attempt> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(`no fact generated for ${destination}: ANTHROPIC_API_KEY is not set`)
    return { type: 'failed' }
  }

  const model = 'claude-opus-5'
  const client = new Anthropic({ timeout: GENERATION_TIMEOUT_MS, maxRetries: 0 })

  // A deadline this side of the SDK as well as inside it. Measured against the
  // real API, a call configured for twenty-five seconds took fifty-five to come
  // back — and the run this happens in is killed at thirty, losing whatever
  // else it was doing. Racing the request guarantees the function moves on,
  // whatever the request does afterwards.
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('deadline')), GENERATION_TIMEOUT_MS).unref(),
  )

  try {
    const response = await Promise.race([deadline, client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // Low effort: this is one sentence off a web search, not a hard problem,
      // and the whole call has twelve seconds to live. Thinking stays on —
      // disabling it on this model risks the tool call arriving as plain text,
      // which would silently mean no search happened at all.
      output_config: { effort: 'low' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: `${PROMPT}${destination}` }],
    })])

    if (response.stop_reason === 'refusal') {
      console.warn(`no fact for ${destination}: the model declined`)
      return { type: 'declined' }
    }

    // The last text block, not all of them joined. With a search tool in play
    // the model often narrates before it searches — one answer arrived as
    // "I'll search for information about Rieupeyroux." followed by the real
    // sentence, and joining the two would have emailed the narration.
    const blocks = response.content.filter((block) => block.type === 'text')
    const text = tidy(blocks[blocks.length - 1]?.text ?? '')

    // The model saying it has nothing is the brief working, not a failure.
    if (!text || text.includes(NOTHING)) return { type: 'declined' }

    // A sentence. Anything longer is the model ignoring the brief, and an email
    // is not the place to find out how much longer.
    if (text.length > 400) {
      console.warn(`discarded an overlong fact for ${destination}: ${text.slice(0, 120)}…`)
      return { type: 'declined' }
    }

    return { type: 'written', generated: { fact: text, model } }
  } catch (error) {
    console.error(`fact generation failed for ${destination}`, error)
    return { type: 'failed' }
  }
}

/**
 * The line for tonight's destination — a lookup, never a generation.
 *
 * The send runs in a scheduled function with about thirty seconds to read the
 * day's riding, render, and hand forty messages to Resend. Writing a sentence
 * takes thirteen of those seconds and sometimes twenty, which is most of the
 * budget spent on the least important thing in it. So the send only ever reads
 * what is already there; fact-warm.mts is what puts it there, hours earlier.
 *
 * A destination nobody has warmed yet simply has no line, which is what the
 * email did on nine mornings in ten before any of this.
 */
export async function factFor(destination: string): Promise<string | null> {
  const written = curated(destination)
  if (written) return written

  try {
    await ensureSchema()
    const stored = (await db()`
      select fact from destination_facts where destination = ${destination}
    `) as unknown as { fact: string }[]
    return stored[0]?.fact ?? null
  } catch (error) {
    console.error(`fact lookup failed for ${destination}`, error)
    return null
  }
}

/** What a warming run did about one place, for the log. */
export type Warmed = 'curated' | 'stored' | 'written' | 'declined' | 'failed' | 'skipped'

/**
 * Makes sure a line exists for a place, writing one if it does not.
 *
 * This is the half that costs time and money, and it runs on its own schedule
 * where neither matters. Returning what it did rather than the sentence keeps
 * the caller's log readable: the sentence itself is logged once, in full, at
 * the moment it is written.
 */
export async function ensureFact(destination: string, mayWrite = true): Promise<Warmed> {
  if (curated(destination)) return 'curated'

  try {
    await ensureSchema()
    const sql = db()

    const stored = (await sql`
      select fact from destination_facts where destination = ${destination}
    `) as unknown as { fact: string }[]
    if (stored[0]?.fact) return 'stored'
    // Already used this run's one write; the next run will pick this up.
    if (!mayWrite) return 'skipped'

    const attempt = await generate(destination)
    if (attempt.type !== 'written') return attempt.type

    const { generated } = attempt
    await sql`
      insert into destination_facts (destination, fact, model)
      values (${destination}, ${generated.fact}, ${generated.model})
      on conflict (destination) do nothing
    `
    // Logged in full: the only place a generated sentence can be read back
    // before it lands in forty inboxes.
    console.log(`fact written for ${destination}: ${generated.fact}`)
    return 'written'
  } catch (error) {
    console.error(`fact warming failed for ${destination}`, error)
    return 'failed'
  }
}
