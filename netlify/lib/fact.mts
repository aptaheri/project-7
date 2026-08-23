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

/**
 * Bumped when the brief changes shape, so stored lines written to an older
 * brief are replaced rather than sitting alongside new ones forever. Version 1
 * was a single sentence and no distance line.
 */
export const FORMAT_VERSION = 2

/**
 * The brief for a place whose fact is already written by hand.
 *
 * Hand-written facts win and are never replaced — that is the whole correction
 * mechanism — but they have never had a distance sentence, so those mornings
 * fell back to the generic arithmetic. This asks for the second piece only, and
 * gives the model the fact that will sit above it so the two read as one
 * thought rather than two unrelated remarks.
 */
const DISTANCE_ONLY_PROMPT = (destination: string, miles: number | null, fact: string) => `A daily email about a cycling expedition goes out tomorrow morning. Tonight the rider arrives in ${destination}, and this paragraph about the place is already written and will appear above your sentence:

"${fact}"

Search the web if it helps, then write ONE sentence, under 30 words, that makes today's ride of ${
  miles === null ? 'an unknown distance' : `${Math.round(miles)} miles (${Math.round(miles * 1.609)} km)`
} mean something — anchored to this place or its region, and ideally picking up something from the paragraph above rather than repeating it.

Rules:
- No preamble, no quotes, no source list. Do not restate the paragraph.
- Numbers are where you are most likely to be wrong. Use only the figures given above, plus at most one length or height you actually found in the search, and keep the comparison simple enough to be checked. Do not estimate, do not multiply your way to a figure you did not verify.
- No superlatives unless a source says so plainly.
- Return an empty string for "distance" if you have nothing you are confident of. An empty string is much better than a plausible guess.
- Return an empty string for "fact" — it is already written.
`

const PROMPT = (destination: string, miles: number | null) => `You write two short pieces of a daily email about a cycling expedition across seven continents. Tonight the rider arrives in the place named below.

Search the web first. Both pieces are read by people who know the rider personally, so anything you write has to be true and specific to that exact place.

PIECE ONE — "fact": two sentences, 45 to 70 words, about the place itself. History, geography, an industry, something that happened there. Give the reader something they would repeat to someone else: a detail, a date, a name, a consequence. Not a guidebook summary.

PIECE TWO — "distance": one sentence, under 30 words, that makes today's ride of ${
  miles === null ? 'an unknown distance' : `${Math.round(miles)} miles (${Math.round(miles * 1.609)} km)`
} mean something, anchored to this place or its region rather than to a generic landmark. ${
  miles === null ? 'You do not know the distance, so return an empty string for this piece.' : ''
}

Rules for both:
- No preamble, no quotes, no source list.
- Write about the place, not about cycling as a sport or the expedition itself.
- Do not describe anywhere as charming, picturesque, quaint, or a hidden gem.
- No superlatives — only, first, oldest, largest, unique — unless a source says so plainly. A true fact with an invented "the only one ever" is a wrong fact.
- Numbers are where you are most likely to be wrong. In the distance sentence use only the figures given above, plus at most one length or height you actually found in the search, and keep any comparison simple enough to be checked. Do not estimate, do not multiply your way to a figure you did not verify.
- If the search does not give you something you are confident of, return an empty string for that piece. Many of these are villages of a few hundred people; an empty string is a perfectly good answer and much better than a plausible guess. The two pieces are independent — an empty distance sentence alongside a good fact is fine.

Place: ${destination}`

/** The shape the model must answer in. Both fields may be empty strings. */
const SCHEMA = {
  type: 'object',
  properties: {
    fact: { type: 'string' },
    distance: { type: 'string' },
  },
  required: ['fact', 'distance'],
  additionalProperties: false,
} as const

interface Generated {
  fact: string
  distance: string | null
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
async function generate(
  destination: string,
  miles: number | null,
  existingFact: string | null = null,
): Promise<Attempt> {
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
      // Low effort: this is a paragraph off a web search, not a hard problem,
      // and the whole call has twenty-five seconds to live. Thinking stays on —
      // disabling it on this model risks the tool call arriving as plain text,
      // which would silently mean no search happened at all.
      //
      // The shape is enforced rather than parsed out of prose: two pieces come
      // back now, and asking the model to delimit them itself is one more thing
      // that can go subtly wrong on a morning nobody is watching.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      messages: [{
        role: 'user',
        content: existingFact
          ? DISTANCE_ONLY_PROMPT(destination, miles, existingFact)
          : PROMPT(destination, miles),
      }],
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
    const answer = blocks[blocks.length - 1]?.text ?? ''

    let parsed: { fact?: unknown; distance?: unknown }
    try {
      parsed = JSON.parse(answer)
    } catch {
      console.warn(`unparseable answer for ${destination}: ${answer.slice(0, 120)}…`)
      return { type: 'declined' }
    }

    // When the fact is already written by hand, that is the fact — the model
    // was asked for the second piece only and told to leave this one empty.
    const fact = existingFact ?? tidy(typeof parsed.fact === 'string' ? parsed.fact : '')
    const distance = tidy(typeof parsed.distance === 'string' ? parsed.distance : '')

    // For a place being written from scratch, an empty fact is the model doing
    // as it was told about a village it could not verify. Nothing to store.
    if (!fact || fact.includes(NOTHING)) return { type: 'declined' }

    // For a hand-written place there is nothing new without a distance line.
    if (existingFact && !distance) return { type: 'declined' }

    // Two sentences. Anything much longer is the model ignoring the brief, and
    // an email is not the place to find out how much longer.
    if (fact.length > 700) {
      console.warn(`discarded an overlong fact for ${destination}: ${fact.slice(0, 120)}…`)
      return { type: 'declined' }
    }

    // The distance line is optional in a way the fact is not: a good fact with
    // no comparison still makes a good morning, and the arithmetic fallback in
    // email.mts covers the gap.
    const usable = distance && !distance.includes(NOTHING) && distance.length <= 240
    if (distance && !usable) {
      console.warn(`dropped an unusable distance line for ${destination}: ${distance.slice(0, 120)}…`)
    }

    return { type: 'written', generated: { fact, distance: usable ? distance : null, model } }
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
export interface DestinationLines {
  /** Two sentences about the place, or null for none. */
  fact: string | null
  /**
   * A sentence putting today's distance in terms of this place, or null.
   *
   * Null is the common case and not a problem: hand-written facts have never
   * had one, and email.mts falls back to the arithmetic comparisons, which are
   * true by construction.
   */
  distance: string | null
}

export async function factFor(destination: string): Promise<DestinationLines> {
  const written = curated(destination)

  try {
    await ensureSchema()
    const stored = (await db()`
      select fact, distance_line from destination_facts where destination = ${destination}
    `) as unknown as { fact: string | null; distance_line: string | null }[]
    return {
      // Hand-written still wins outright. The stored row may exist anyway,
      // holding the distance sentence written about that hand-written fact —
      // or nothing but the record of having tried, in which case its fact is
      // null and the email opens without a line, as it always has.
      fact: written ?? stored[0]?.fact ?? null,
      distance: stored[0]?.distance_line ?? null,
    }
  } catch (error) {
    console.error(`fact lookup failed for ${destination}`, error)
    return { fact: written, distance: null }
  }
}

/** What a warming run did about one place, for the log. */
export type Warmed =
  | 'curated'
  | 'stored'
  | 'written'
  | 'declined'
  | 'failed'
  | 'skipped'
  | 'exhausted'

/**
 * How many times the model may answer "I have nothing" about one place before
 * it stops being asked.
 *
 * The empty answer is correct behaviour, not an error — many of these are
 * villages of a few hundred people. But nothing was stored when it happened, so
 * the next run asked again, and the one after that, at about two cents and
 * twenty-five seconds a time, forever. Three refusals is enough to believe it.
 *
 * Raising FORMAT_VERSION revives every place given up on, which is right: a new
 * brief is a different question and deserves a fresh answer.
 */
const GIVE_UP_AFTER = 3

/**
 * Makes sure a line exists for a place, writing one if it does not.
 *
 * This is the half that costs time and money, and it runs on its own schedule
 * where neither matters. Returning what it did rather than the sentence keeps
 * the caller's log readable: the sentence itself is logged once, in full, at
 * the moment it is written.
 */
export async function ensureFact(
  destination: string,
  miles: number | null,
  mayWrite = true,
): Promise<Warmed> {
  const written = curated(destination)

  try {
    await ensureSchema()
    const sql = db()

    const stored = (await sql`
      select fact, distance_line, format_version, attempts
      from destination_facts where destination = ${destination}
    `) as unknown as {
      fact: string | null
      distance_line: string | null
      format_version: number
      attempts: number
    }[]

    // Written to an older brief — a single sentence, no distance line. Replace
    // it rather than leave two shapes of email going out depending on when a
    // place happened to be warmed.
    const outdated = stored[0] && stored[0].format_version < FORMAT_VERSION

    // A hand-written place needs nothing but its distance sentence, and needs
    // that only once. Its fact is never regenerated.
    if (written) {
      if (stored[0]?.distance_line && !outdated) return 'stored'
    } else if (stored[0]?.fact && !outdated) {
      return 'stored'
    }

    // Asked enough times already and told each time that there is nothing to
    // say. Believe it, and stop spending a run's one attempt on it.
    if (!outdated && (stored[0]?.attempts ?? 0) >= GIVE_UP_AFTER) return 'exhausted'

    // Already used this run's one attempt; the next run will pick this up.
    if (!mayWrite) return 'skipped'

    const attempt = await generate(destination, miles, written)

    // A decline is recorded rather than forgotten. The row may hold no fact at
    // all — it exists only to say that this was tried, and how often.
    if (attempt.type === 'declined') {
      const attempts = (outdated ? 0 : (stored[0]?.attempts ?? 0)) + 1
      await sql`
        insert into destination_facts
          (destination, fact, model, format_version, attempts, declined_at)
        values (${destination}, null, ${'claude-opus-5'}, ${FORMAT_VERSION}, ${attempts}, now())
        on conflict (destination) do update set
          format_version = excluded.format_version,
          attempts = excluded.attempts,
          declined_at = now()
      `
      if (attempts >= GIVE_UP_AFTER) {
        console.log(`fact: giving up on ${destination} after ${attempts} attempts`)
      }
      return 'declined'
    }

    if (attempt.type !== 'written') return attempt.type

    const { generated } = attempt
    await sql`
      insert into destination_facts
        (destination, fact, distance_line, model, format_version, attempts)
      values (
        ${destination}, ${generated.fact}, ${generated.distance},
        ${generated.model}, ${FORMAT_VERSION}, 0
      )
      on conflict (destination) do update set
        fact = excluded.fact,
        distance_line = excluded.distance_line,
        model = excluded.model,
        format_version = excluded.format_version,
        -- A place that finally answered is no longer one that has been given up
        -- on, so the count of refusals goes back to nothing.
        attempts = 0,
        declined_at = null,
        created_at = now()
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
