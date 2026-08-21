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
 * How long the whole attempt may take.
 *
 * The send runs in a scheduled function with about thirty seconds to do
 * everything — read the day's riding, render, and hand forty messages to
 * Resend. A fact is the least important thing in that budget, so it gets a
 * slice of it and is dropped the moment it overruns. The email is never late
 * because of an anecdote.
 */
const DEADLINE_MS = 12_000

/** Long enough for a sentence and the thinking behind it, and no longer. */
const MAX_TOKENS = 4096

/** The model returns this exact word when it has nothing it can stand behind. */
const NOTHING = 'NONE'

const PROMPT = `You write one sentence for a daily email about a cycling expedition across seven continents. Tonight the rider arrives in the place named below.

Search the web, then write ONE sentence about that place that a reader would find genuinely interesting — history, geography, an industry, something that happened there. It is read by people who know the rider personally, so it must be true and specific to that exact place.

Rules:
- One sentence. No preamble, no quotes, no source list.
- It must be a fact about the place, not about cycling or the expedition.
- Do not describe it as charming, picturesque, quaint, or a hidden gem.
- If the search does not give you something you are confident is true and specific to this place, reply with exactly ${NOTHING}. Many of these are villages of a few hundred people; ${NOTHING} is a perfectly good answer and is much better than a plausible guess.

Place: `

interface Generated {
  fact: string
  model: string
}

/**
 * Asks Claude for a sentence, with the web available to check itself.
 *
 * Returns null on anything at all going wrong — no key, a refusal, a timeout, a
 * malformed answer. Every one of those means the email prints one line fewer,
 * which is a thing it already does most mornings.
 */
async function generate(destination: string): Promise<Generated | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(`no fact generated for ${destination}: ANTHROPIC_API_KEY is not set`)
    return null
  }

  const model = 'claude-opus-5'
  const client = new Anthropic({ timeout: DEADLINE_MS, maxRetries: 1 })

  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // Low effort: this is one sentence off a web search, not a hard problem,
      // and the whole call has twelve seconds to live. Thinking stays on —
      // disabling it on this model risks the tool call arriving as plain text,
      // which would silently mean no search happened at all.
      output_config: { effort: 'low' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: `${PROMPT}${destination}` }],
    })

    if (response.stop_reason === 'refusal') {
      console.warn(`no fact for ${destination}: the model declined`)
      return null
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim()

    // The model saying it has nothing is a success, not a failure.
    if (!text || text === NOTHING || text.includes(NOTHING)) return null

    // A sentence. Anything longer is the model ignoring the brief, and an email
    // is not the place to find out how much longer.
    if (text.length > 400) {
      console.warn(`discarded an overlong fact for ${destination}: ${text.slice(0, 120)}…`)
      return null
    }

    return { fact: text, model }
  } catch (error) {
    console.error(`fact generation failed for ${destination}`, error)
    return null
  }
}

/**
 * The line for tonight's destination: hand-written, previously generated, or
 * generated now.
 *
 * Stored on the way out so the same place is never paid for or re-invented
 * twice — which matters more than it sounds, because a hundred of the days on
 * this route are rest days spent in the town he reached the night before.
 */
export async function factFor(destination: string): Promise<string | null> {
  const written = curated(destination)
  if (written) return written

  try {
    await ensureSchema()
    const sql = db()

    const stored = (await sql`
      select fact from destination_facts where destination = ${destination}
    `) as unknown as { fact: string }[]
    if (stored[0]?.fact) return stored[0].fact

    const generated = await generate(destination)
    if (!generated) return null

    await sql`
      insert into destination_facts (destination, fact, model)
      values (${destination}, ${generated.fact}, ${generated.model})
      on conflict (destination) do nothing
    `
    // Logged in full: this is the only place a generated sentence can be read
    // back from before it lands in forty inboxes.
    console.log(`fact generated for ${destination}: ${generated.fact}`)
    return generated.fact
  } catch (error) {
    console.error(`fact lookup failed for ${destination}`, error)
    return null
  }
}
