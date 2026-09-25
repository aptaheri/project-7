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
 * was a single sentence and no second line. Version 2 asked for two sentences
 * of 45 to 70 words, which is what produced paragraphs like the one about
 * Scuol: three clauses spliced together, four dates, and the best thing in it —
 * the mouthwash millionaire who bought a castle — buried at the very end.
 *
 * Version 3 asks for short sentences, one idea each, the best thing first, and
 * a second line about the day's riding rather than an arithmetic comparison.
 *
 * Version 4 asks for two paragraphs instead of one, because asking for length
 * never worked and asking for a different *kind* of content does: the history,
 * and then what the place is now — a festival coming up, something that
 * happened there recently, what it is known for today. Two questions produce
 * two answers; one question with a bigger word count produced the same two
 * sentences however it was phrased.
 */
export const FORMAT_VERSION = 4

/**
 * The brief for a place whose fact is already written by hand.
 *
 * Hand-written facts win and are never replaced — that is the whole correction
 * mechanism — but they have never had a distance sentence, so those mornings
 * fell back to the generic arithmetic. This asks for the ride line only, and
 * gives the model the fact that will sit above it so the two read as one
 * thought rather than two unrelated remarks.
 *
 * What the place is now is asked separately, by NOW_PROMPT, on a later run —
 * for hand-written places exactly as for generated ones.
 */
const CURATED_PROMPT = (destination: string, ride: RideContext, fact: string) => `A daily email about a cycling expedition goes out tomorrow morning. Tonight the rider reaches ${destination}. This paragraph about the place is already written by hand and will appear exactly as it is, above whatever you write:

"${fact}"

Do not rewrite it, add to it, or repeat it. It is a correction somebody made deliberately and it stands.

Write the one piece it does not cover.

"ride": one or two sentences about what kind of day today is for the rider.

Today he rides ${ride.from ? `from ${ride.from} ` : ''}to ${destination}${
  ride.miles === null
    ? ', distance unknown'
    : `, ${Math.round(ride.miles)} miles (${Math.round(ride.miles * 1.609)} km)`
}.${ride.note ? ` The route notes say: ${ride.note}.` : ''}

A hundred miles or more is a century and a big day. Under forty is a short one. A mountain pass is a day of climbing, worth naming if you can verify it.

Rules:
- No preamble, no quotes, no source list, no headings.
- Short sentences, one idea each, plain English, no semicolons.
- No superlatives unless a source says so plainly.
- Say when something is happening if you know, and do not imply something is imminent if you only know it is annual.
- Use only figures you verified, plus the distance given above.
- Return an empty string for "ride" if you cannot make it true and specific.
- Return an empty string for "history" and for "now" — they are handled elsewhere.
`

const PROMPT = (destination: string, ride: RideContext) => `You write the part of a daily email about a cycling expedition that people actually read: a short piece about the town the rider reaches tonight. It is the only thing in the email that changes from one day to the next.

Search the web first.

PIECE ONE — "history": two or three sentences about the place, past tense. Plain English a twelve-year-old would follow. Lead with the single most surprising or human thing you found — not where the town is, and not a list of centuries. A person, something that happened, something that failed, something still standing. The kind of detail somebody repeats to whoever is in the room.

PIECE TWO — "ride": one or two sentences about what kind of day today is for the rider.

Today he rides ${ride.from ? `from ${ride.from} ` : ''}to ${destination}${
  ride.miles === null
    ? ', distance unknown'
    : `, ${Math.round(ride.miles)} miles (${Math.round(ride.miles * 1.609)} km)`
}.${ride.note ? ` The route notes say: ${ride.note}.` : ''}

A hundred miles or more is a century and a big day. Under forty is a short one. A mountain pass is a day of climbing, and it is worth naming the pass and roughly how high if you can verify it.

Rules for all three:
- No preamble, no quotes, no source list, no headings.
- Short sentences. One idea each. No semicolons.
- Plain words. "Spa town", not "internationally known spa resort destination".
- Do not describe anywhere as charming, picturesque, quaint, or a hidden gem.
- No superlatives — only, first, oldest, largest, unique — unless a source says so plainly.
- Numbers are where you are most likely to be wrong. Use the distance given above, plus at most one height or length you actually found. Do not estimate.
- Return an empty string for either piece you cannot make true and specific. The two are independent, and an empty one is much better than a plausible guess — many of these are villages of a few hundred people.
- Return an empty string for "now". It is asked separately.

Place: ${destination}`

/** The shape the model must answer in. Both fields may be empty strings. */
/**
 * Below this many words, a place is asked once whether there is more.
 *
 * Dubrovnik came back as twenty-eight words — city walls, an independent
 * republic — for somewhere with a thousand years of written history. The brief
 * has asked for more since version 3 and the model does not oblige: four
 * rewrites, a hard floor, a three-beat structure and a run at medium effort all
 * produced the same two sentences. It writes what it verified in one pass and
 * stops.
 *
 * So the second pass is a second question rather than a firmer instruction. It
 * is asked once per place. If it cannot do better, the place is marked as
 * having little to say and is never asked again.
 */
const MIN_FACT_WORDS = 50

function wordsIn(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/**
 * The second question, for a place that came back thinner than it deserves.
 *
 * Given what it already wrote, so it extends rather than starts again — and
 * told plainly that returning the same thing is a fine answer, because for a
 * hamlet it is the true one.
 */
const EXPAND_PROMPT = (destination: string, existing: string) => `You wrote this about ${destination} for a daily email about a cycling expedition:

"${existing}"

It is shorter than the brief allows. Search the web again and decide honestly: is there more here worth telling, or is this genuinely a small place with little recorded about it?

If there is more, write the fuller version — the whole paragraph, not an addition to paste on the end. Up to 120 words. Keep what is already there if it is the best of it, and add what you verify: a person, an industry, something that happened, what the place is now. Same voice as before — short sentences, one idea each, no semicolons, plain words, the surprising thing first.

If there is not more, return exactly what is quoted above and nothing else. That is a real answer and there is no penalty for it; many of these are villages of a few hundred people.

Rules:
- No preamble, no quotes around the answer, no source list.
- Do not describe anywhere as charming, picturesque, quaint, or a hidden gem.
- No superlatives unless a source says so plainly.
- Use only figures you have actually verified.
- Return an empty string for "ride" — the distance sentence is already written.

Place: ${destination}`

/**
 * The second question: what the place is now.
 *
 * Asked on its own run rather than alongside the history, because asking for
 * both at once takes more than the twenty-five seconds a scheduled function can
 * give — measured, three times, on Davos, Kavala and Scuol, all of which came
 * back with nothing at all. Two questions of twenty seconds fit where one of
 * forty does not, and the warmer already knows how to come back tomorrow.
 *
 * Handed the history so it does not repeat it. This is the half readers said
 * was missing: not what happened here, but what is happening here.
 */
const NOW_PROMPT = (destination: string, history: string) => `A daily email about a cycling expedition reaches ${destination} tonight. This paragraph about the place is already written and will appear above yours:

"${history}"

Search the web — news, and what is scheduled — and write two or three sentences about ${destination} today. Not its history: the present.

Almost every inhabited place has an answer to this, so look for one before deciding there is none. What does the town live on now — an industry, a crop, tourism, a university, a port? What is it known for today? What is coming up there, or what happened there recently? For Davos that is the World Economic Forum each January — who is going, what is on the agenda. For a fishing town it might be the season and the catch. For a small one it might simply be what most people there do for a living, and that is a perfectly good answer.

Rules:
- No preamble, no quotes, no source list, no headings.
- Never write about yourself or about searching. Not what you could or could not find, not how confident you are, not what to treat the answer as. The reader is expecting a paragraph about a town and nothing else. If a search failed, leave that sentence out; if that leaves you with nothing, return an empty string.
- Do not repeat anything in the paragraph above.
- Short sentences. One idea each. Plain English. No semicolons.
- Say when something is happening if you know it. Do not imply something is imminent when you only know it is annual — "each January" is honest, "next week" had better be true.
- No superlatives unless a source says so plainly. Use only figures you verified.
- Return an empty string only if you genuinely cannot find out anything about the place as it is today. That is the right answer for a hamlet of forty people and it will not be asked again — but it is the wrong answer for anywhere with a population, an economy or a season, and those are most of them.

Place: ${destination}`

const NOW_SCHEMA = {
  type: 'object',
  properties: { now: { type: 'string' } },
  required: ['now'],
  additionalProperties: false,
} as const

const SCHEMA = {
  type: 'object',
  properties: {
    history: { type: 'string' },
    now: { type: 'string' },
    ride: { type: 'string' },
  },
  required: ['history', 'now', 'ride'],
  additionalProperties: false,
} as const

/**
 * What today's riding actually is, so the second line can be about the day
 * rather than an arithmetic comparison nobody asked for.
 *
 * `note` is whatever the route says about the day — "Klausen Pass", "Alps" —
 * which is the only signal there is for whether it is a climbing day, since
 * nothing here knows elevation ahead of time.
 */
export interface RideContext {
  miles: number | null
  from?: string | null
  note?: string | null
}

interface Generated {
  fact: string
  /** What the place is now — the half that used to be missing. */
  now: string | null
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
/**
 * Strips sentences the model wrote about itself.
 *
 * Asked about Bad Wiessee the model finished with "I could not reach any news
 * sources tonight, so take this as background rather than the latest word" —
 * true, useful to a developer, and addressed to entirely the wrong person. The
 * brief now forbids it, but a brief is not a guarantee and this one goes to
 * forty inboxes unread.
 *
 * Sentence-wise rather than all-or-nothing: the three sentences before that one
 * were exactly what was wanted. What is left has to still be worth printing,
 * and a paragraph trimmed to a fragment is not.
 */
const ASIDE = /\b(I|I'm|I've|my)\b|\bsearch(es|ed|ing)?\b|\bsources?\b|\bas of\b/i
const MIN_NOW_WORDS = 15

function withoutAsides(text: string): string {
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !ASIDE.test(sentence))
    .join(' ')
    .trim()
  return wordsIn(kept) >= MIN_NOW_WORDS ? kept : ''
}

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
/**
 * Which question this call is asking.
 *
 * `fresh` writes the history and the ride line for a place with nothing.
 * `curated` writes the ride line only, under a hand-written paragraph.
 * `expand` asks whether a thin paragraph has more in it.
 * `now` asks the second question — what the place is today — given the first.
 *
 * They are separate calls rather than one because one call asking for both
 * halves does not come back inside twenty-five seconds. Davos, Kavala and Scuol
 * were each measured at the full deadline and returned nothing at all.
 */
type Mode = 'fresh' | 'curated' | 'expand' | 'now'

async function generate(
  destination: string,
  ride: RideContext,
  mode: Mode,
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
        format: { type: 'json_schema', schema: mode === 'now' ? NOW_SCHEMA : SCHEMA },
      },
      // Two searches for the present, three for everything else. Measured:
      // Davos answers the modern question in six to fifteen seconds because it
      // is heavily written about, but Kavala and Scuol spent the whole
      // twenty-five and returned nothing — news results are longer and there
      // are more of them to read. A tighter budget is what brings those inside
      // the deadline, and a place it cannot answer in two searches is a place
      // with little to report.
      tools: [{
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: mode === 'now' ? 2 : 3,
      }],
      messages: [{
        role: 'user',
        content:
          mode === 'now'
            ? NOW_PROMPT(destination, existingFact ?? '')
            : mode === 'expand'
              ? EXPAND_PROMPT(destination, existingFact ?? '')
              : mode === 'curated'
                ? CURATED_PROMPT(destination, ride, existingFact ?? '')
                : PROMPT(destination, ride),
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

    let parsed: { history?: unknown; now?: unknown; ride?: unknown }
    try {
      parsed = JSON.parse(answer)
    } catch {
      console.warn(`unparseable answer for ${destination}: ${answer.slice(0, 120)}…`)
      return { type: 'declined' }
    }

    // Only the two questions that write a paragraph read one back. The others
    // were handed the paragraph that stands and asked for something beside it.
    const fact =
      mode === 'fresh' || mode === 'expand'
        ? tidy(typeof parsed.history === 'string' ? parsed.history : '')
        : existingFact ?? ''
    const nowText = tidy(typeof parsed.now === 'string' ? parsed.now : '')
    const distance = tidy(typeof parsed.ride === 'string' ? parsed.ride : '')

    // The second question answers on its own terms and returns here. An empty
    // answer is a real one — a hamlet with nothing scheduled and nothing in the
    // news is the ordinary case — and the empty string is what records that it
    // was asked, so it is never asked again.
    if (mode === 'now') {
      const spoken = withoutAsides(nowText)
      if (nowText && spoken !== nowText) {
        console.warn(`trimmed an aside from the now line for ${destination}: ${nowText.slice(0, 160)}…`)
      }
      const usableNow = spoken && !spoken.includes(NOTHING) && spoken.length <= 700
      if (nowText && !usableNow) {
        console.warn(`dropped an unusable now line for ${destination}: ${nowText.slice(0, 120)}…`)
      }
      return {
        type: 'written',
        generated: { fact, now: usableNow ? spoken : '', distance: null, model },
      }
    }

    // For a place being written from scratch, an empty fact is the model doing
    // as it was told about a village it could not verify. Nothing to store.
    if (!fact || fact.includes(NOTHING)) return { type: 'declined' }

    // Asked only for the ride line, there is nothing new without one.
    if (mode === 'curated' && !distance) return { type: 'declined' }

    // The brief asks for a hundred words. Anything approaching double that is
    // the model ignoring it, and an email is not the place to find out.
    if (fact.length > 900) {
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

    // The modern half is optional in the same way the ride line is: a village
    // with nothing scheduled and nothing in the news is the ordinary case, and
    // an invented festival would be far worse than a missing paragraph.
    const nowUsable = nowText && !nowText.includes(NOTHING) && nowText.length <= 700
    if (nowText && !nowUsable) {
      console.warn(`dropped an unusable now line for ${destination}: ${nowText.slice(0, 120)}…`)
    }

    return {
      type: 'written',
      generated: { fact, now: nowUsable ? nowText : null, distance: usable ? distance : null, model },
    }
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
   * What the place is now — something coming up, something recent, what it
   * lives on. Null when there was nothing worth saying, which for a hamlet is
   * most of the time.
   */
  now: string | null
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
      select fact, now_line, distance_line from destination_facts
      where destination = ${destination}
    `) as unknown as {
      fact: string | null
      now_line: string | null
      distance_line: string | null
    }[]
    return {
      // Hand-written still wins outright. The stored row may exist anyway,
      // holding the distance sentence written about that hand-written fact —
      // or nothing but the record of having tried, in which case its fact is
      // null and the email opens without a line, as it always has.
      fact: written ?? stored[0]?.fact ?? null,
      // An empty string is the record of having asked and been told there is
      // nothing current. The reader wants the same thing as never-asked: no
      // paragraph.
      now: stored[0]?.now_line || null,
      distance: stored[0]?.distance_line ?? null,
    }
  } catch (error) {
    console.error(`fact lookup failed for ${destination}`, error)
    return { fact: written, now: null, distance: null }
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
  /** The rest of what today's ride is, for the second line. */
  ride: Omit<RideContext, 'miles'> = {},
): Promise<Warmed> {
  const written = curated(destination)

  try {
    await ensureSchema()
    const sql = db()

    const stored = (await sql`
      select fact, now_line, distance_line, distance_miles, format_version, attempts, thin
      from destination_facts where destination = ${destination}
    `) as unknown as {
      fact: string | null
      now_line: string | null
      distance_line: string | null
      distance_miles: number | null
      format_version: number
      attempts: number
      thin: boolean | null
    }[]

    // The sentence was written about a number, and the number has changed —
    // John corrected the day's distance, or routed it differently. The fact is
    // still true; the comparison is not.
    const staleDistance =
      Boolean(stored[0]?.distance_line) &&
      miles !== null &&
      Math.abs((stored[0]?.distance_miles ?? miles) - miles) >= 1

    // Written to an older brief — a single sentence, no distance line. Replace
    // it rather than leave two shapes of email going out depending on when a
    // place happened to be warmed.
    const outdated = stored[0] && stored[0].format_version < FORMAT_VERSION

    // A place that came back thinner than it deserves gets one follow-up
    // question. Dubrovnik was twenty-eight words, and the brief asking for more
    // has never worked — so this asks again rather than instructing harder. A
    // place that has already answered "no, that is all there is" carries thin
    // and is left alone; a hand-written fact is never touched.
    const short =
      !written &&
      Boolean(stored[0]?.fact) &&
      stored[0]?.thin !== true &&
      wordsIn(stored[0]?.fact ?? '') < MIN_FACT_WORDS

    // Nothing left to ask about this place. A hand-written one is complete once
    // it has both the lines it never had — the ride sentence and the modern
    // paragraph — and its fact is still never regenerated. A generated one is
    // complete once it has a paragraph, has been asked about the present, and
    // is neither thin nor out of date.
    const haveFact = written ?? stored[0]?.fact ?? null
    const askedAboutNow = stored[0]?.now_line != null
    const complete =
      Boolean(haveFact) &&
      askedAboutNow &&
      !outdated &&
      !staleDistance &&
      !short &&
      (!written || Boolean(stored[0]?.distance_line))
    if (complete) return 'stored'

    // Asked enough times already and told each time that there is nothing to
    // say. Believe it, and stop spending a run's one attempt on it.
    if (!outdated && (stored[0]?.attempts ?? 0) >= GIVE_UP_AFTER) return 'exhausted'

    // Already used this run's one attempt; the next run will pick this up.
    if (!mayWrite) return 'skipped'

    // One question per run, in the order that matters most to a reader.
    //
    // A place with no paragraph needs one before anything else, then a thin one
    // is asked whether there is more. The ride line comes before the present
    // because it can be *wrong* rather than merely missing — a corrected
    // distance is a sentence about a number that has changed, and leaving it a
    // run longer than necessary means emailing the old one. The present is
    // asked last because a place that never gets one loses a paragraph, which
    // is what every morning looked like before any of this.
    //
    // Rewriting a stale comparison does not mean rewriting the paragraph above
    // it: the place has not changed, only the distance to it. The existing fact
    // is handed back as context, exactly as a hand-written one is.
    const mode: Mode =
      !written && (!stored[0]?.fact || outdated)
        ? 'fresh'
        : short
          ? 'expand'
          : staleDistance || (written && !stored[0]?.distance_line)
            ? 'curated'
            : 'now'
    const keepFact = mode === 'fresh' ? null : haveFact
    const attempt = await generate(destination, { ...ride, miles }, mode, keepFact)

    // The second question, recorded whatever it said. The empty string is the
    // record of having asked and been told there is nothing — which is why this
    // writes rather than skips, and why it is an upsert: a hand-written place
    // reaches this with no row of its own at all.
    if (mode === 'now') {
      if (attempt.type !== 'written') return attempt.type
      const line = attempt.generated.now ?? ''
      await sql`
        insert into destination_facts
          (destination, fact, now_line, model, format_version, attempts)
        values (${destination}, null, ${line}, ${attempt.generated.model}, ${FORMAT_VERSION}, 0)
        on conflict (destination) do update set
          now_line = excluded.now_line,
          format_version = excluded.format_version,
          attempts = 0,
          declined_at = null
      `
      if (line) console.log(`now written for ${destination}: ${line}`)
      else console.log(`now: nothing current to say about ${destination}`)
      return 'written'
    }

    if (mode === 'expand') {
      const grown =
        attempt.type === 'written' &&
        wordsIn(attempt.generated.fact) > wordsIn(stored[0]?.fact ?? '')
      if (!grown) {
        // Asked and answered. Marked so a hamlet is not asked forever.
        await sql`
          update destination_facts set thin = true where destination = ${destination}
        `
        console.log(`fact: ${destination} has no more to say, left at ${wordsIn(stored[0]?.fact ?? '')} words`)
        return 'stored'
      }
      await sql`
        update destination_facts
           set fact = ${attempt.generated.fact}, thin = false, created_at = now()
         where destination = ${destination}
      `
      console.log(
        `fact expanded for ${destination}: ${wordsIn(stored[0]?.fact ?? '')} -> ` +
          `${wordsIn(attempt.generated.fact)} words`,
      )
      return 'written'
    }

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
        (destination, fact, now_line, distance_line, distance_miles, model, format_version, attempts)
      values (
        ${destination}, ${generated.fact}, ${generated.now}, ${generated.distance}, ${miles},
        ${generated.model}, ${FORMAT_VERSION}, 0
      )
      on conflict (destination) do update set
        fact = excluded.fact,
        now_line = excluded.now_line,
        distance_line = excluded.distance_line,
        distance_miles = excluded.distance_miles,
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
