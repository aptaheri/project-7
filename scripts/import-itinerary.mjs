/**
 * import-itinerary.mjs
 *
 * Turns the itinerary PDF into src/data/itinerary.json.
 *
 * Usage:
 *   node scripts/import-itinerary.mjs "~/Downloads/Project 7 Itinerary.pdf"
 *
 * Requires pdftotext (brew install poppler).
 *
 * The output is committed rather than written straight to the database: a bad
 * parse should be visible in a diff and fixable in an editor, not something
 * that silently corrupts live data.
 *
 * The PDF states its own per-stage mileage and bike-day totals, so the parse is
 * checked against those. A stage that does not reconcile is reported and the
 * file is not written unless --force is passed.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The trip starts in 2026; the PDF gives weekdays and dates but never a year. */
const START_YEAR = 2026

/** Countries the route passes through, used to split a place from a note. */
const COUNTRIES = [
  'Portugal', 'Spain', 'France', 'Italy', 'Switzerland', 'Austria', 'Croatia',
  'Montenegro', 'Albania', 'Greece', 'Türkiye', 'Turkey', 'Georgia', 'Azerbaijan',
  'Kazakhstan', 'Uzbekistan', 'Kyrgyzstan', 'Australia', 'WA', 'SA', 'NSW', 'VIC',
  'Ecuador', 'Peru', 'Bolivia', 'Argentina', 'Brazil', 'Chile', 'Senegal', 'Mali',
  'Burkina Faso', 'Ghana', 'Togo', 'Benin', 'Nigeria', 'Cameroon', 'Chad',
  'Central African Republic', 'DRC', 'Uganda', 'Kenya', 'Tanzania', 'Rwanda',
  'India', 'Nepal', 'China', 'Myanmar', 'Thailand', 'Laos', 'Vietnam',
  'CA', 'AZ', 'NM', 'TX', 'OK', 'AR', 'TN', 'VA', 'MD', 'PA', 'NJ', 'NY',
  'Antarctica',
]

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}

const DAY_NAMES = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun'
const ROW = new RegExp(`^\\s*(?:${DAY_NAMES})\\s+([A-Z][a-z]{2})\\s+(\\d{1,2})\\s+(.*?)\\s+(\\d+)\\s*$`)
const STAGE_HEADER = /^STAGE\s+([0-9A]+)\s*:\s*(.+)$/i
const STAGE_TOTALS = /STAGE\s+([0-9A]+)\s+MILES:\s*([\d,]+)\s+BIKE DAYS:\s*(\d+)/i

/**
 * pdftotext splits the leading weekday and date themselves — "S un", "Su n",
 * "Oct 2 7". Only single spaces between a letter and a lowercase letter, or
 * between two digits, are closed, and only in the leading columns, so place
 * names further along the line are untouched.
 */
function fixRowPrefix(line) {
  const WIDTH = 16
  const head = line
    .slice(0, WIDTH)
    .replace(/(?<=[A-Za-z])\s(?=[a-z])/g, '')
    .replace(/(?<=\d)\s(?=\d)/g, '')
  return head + line.slice(WIDTH)
}

/** Antarctica is a different undertaking and its rows do not share this shape. */
const SKIP_STAGES = new Set(['7'])

/** pdftotext inserts spaces inside words; this only matters for comparison. */
function normalise(value) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function tidy(value) {
  return value.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim()
}

/** Every named waypoint on the planned route, keyed for loose comparison. */
function loadWaypoints() {
  const byName = new Map()
  const dir = path.join(ROOT, 'public', 'geojson')
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('-map.geojson')) continue
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    for (const feature of data.features) {
      if (feature.geometry?.type !== 'Point') continue
      const name = feature.properties?.name
      if (!name) continue
      const key = normalise(name)
      // First occurrence wins: stages are read in order, and a repeated name is
      // the same town appearing at a stage boundary.
      if (!byName.has(key)) {
        byName.set(key, { name, coords: feature.geometry.coordinates })
      }
    }
  }
  return byName
}

/** Separates "Nazaré, Portugal Praia do Guincho Tire Dip" into place and note. */
function splitPlace(raw) {
  const text = tidy(raw)
  const comma = text.indexOf(',')
  if (comma === -1) return { place: text, note: '' }

  const place = text.slice(0, comma).trim()
  const after = text.slice(comma + 1).trim()

  const country = COUNTRIES
    .filter((c) => after.toLowerCase().startsWith(c.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0]

  if (!country) return { place, note: after }
  return { place, note: after.slice(country.length).trim() }
}

function parse(text) {
  const waypoints = loadWaypoints()
  const lines = text.split('\n')

  const stageTotals = new Map()
  for (const line of lines) {
    const m = line.match(STAGE_TOTALS)
    if (m) {
      stageTotals.set(m[1].toLowerCase(), {
        miles: Number(m[2].replace(/,/g, '')),
        bikeDays: Number(m[3]),
      })
    }
  }

  const stages = []
  const days = []
  let stage = null
  let year = START_YEAR
  let previousMonth = -1

  for (const line of lines) {
    const header = line.trim().match(STAGE_HEADER)
    if (header && !STAGE_TOTALS.test(line)) {
      const id = header[1].toLowerCase()
      if (!stages.some((s) => s.id === id)) {
          stages.push({
          id,
          title: tidy(header[2]),
          ...stageTotals.get(id),
          ...(SKIP_STAGES.has(id) ? { parsed: false } : {}),
        })
      }
      stage = id
      continue
    }

    const row = fixRowPrefix(line).match(ROW)
    if (!row || stage === null) continue

    const [, monthName, dayOfMonth, bodyRaw, dayNumber] = row
    const month = MONTHS[monthName]
    if (month === undefined) continue

    // The PDF never repeats the year; a month going backwards means January.
    if (previousMonth !== -1 && month < previousMonth) year += 1
    previousMonth = month

    const date = `${year}-${String(month + 1).padStart(2, '0')}-${dayOfMonth.padStart(2, '0')}`
    const body = tidy(bodyRaw)

    const milesMatch = body.match(/([\d,]+)\s*m\s*i\s*$/i)
    const miles = milesMatch ? Number(milesMatch[1].replace(/,/g, '')) : null
    const withoutMiles = milesMatch ? body.slice(0, milesMatch.index).trim() : body

    const entry = {
      day: Number(dayNumber),
      date,
      stage,
      kind: 'ride',
      from: null,
      to: null,
      miles,
      note: '',
      fromCoords: null,
      toCoords: null,
      needsReview: false,
    }

    if (/rest day/i.test(withoutMiles)) {
      entry.kind = 'rest'
      const where = withoutMiles.replace(/.*rest day (?:in|at)\s*/i, '')
      const { place, note } = splitPlace(where)
      entry.to = place
      entry.note = note
    } else if (/travel day/i.test(withoutMiles)) {
      entry.kind = 'travel'
      entry.note = withoutMiles
    } else {
      const parts = withoutMiles.split(/\s+to\s+/)
      if (parts.length < 2) {
        entry.kind = 'other'
        entry.note = withoutMiles
      } else {
        const fromSide = splitPlace(parts[0])
        const toSide = splitPlace(parts.slice(1).join(' to '))
        entry.from = fromSide.place
        entry.to = toSide.place
        entry.note = [fromSide.note, toSide.note].filter(Boolean).join(' ').trim()
      }
    }

    for (const side of ['from', 'to']) {
      const name = entry[side]
      if (!name) continue
      const hit = waypoints.get(normalise(name))
      if (hit) {
        // Prefer the waypoint's spelling: the PDF text has spaces inside words.
        entry[side] = hit.name
        entry[`${side}Coords`] = hit.coords
      } else if (entry.kind === 'ride') {
        entry.needsReview = true
      }
    }

    days.push(entry)
  }

  return { stages, days }
}

function validate(stages, days) {
  const problems = []
  for (const stage of stages) {
    if (stage.bikeDays === undefined || SKIP_STAGES.has(stage.id)) continue
    const rides = days.filter((d) => d.stage === stage.id && d.kind === 'ride')
    const miles = rides.reduce((sum, d) => sum + (d.miles ?? 0), 0)
    const okDays = rides.length === stage.bikeDays
    const okMiles = Math.abs(miles - stage.miles) <= 1
    if (!okDays || !okMiles) {
      problems.push(
        `stage ${stage.id}: parsed ${rides.length} ride days / ${miles} mi, ` +
          `PDF declares ${stage.bikeDays} / ${stage.miles}`,
      )
    }
  }
  return problems
}

// ── Run ──────────────────────────────────────────────────────────────────────

const input = process.argv[2]
const force = process.argv.includes('--force')
if (!input) {
  console.error('Usage: node scripts/import-itinerary.mjs <itinerary.pdf> [--force]')
  process.exit(1)
}

const pdfPath = input.replace(/^~/, process.env.HOME ?? '~')
if (!fs.existsSync(pdfPath)) {
  console.error(`Not found: ${pdfPath}`)
  process.exit(1)
}

const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' })
const { stages, days } = parse(text)
const problems = validate(stages, days)

const rides = days.filter((d) => d.kind === 'ride')
const review = rides.filter((d) => d.needsReview)

console.log(`stages       : ${stages.length}`)
console.log(`days parsed  : ${days.length}`)
console.log(`  ride       : ${rides.length}`)
console.log(`  rest       : ${days.filter((d) => d.kind === 'rest').length}`)
console.log(`  travel     : ${days.filter((d) => d.kind === 'travel').length}`)
console.log(`  other      : ${days.filter((d) => d.kind === 'other').length}`)
console.log(`total miles  : ${rides.reduce((s, d) => s + (d.miles ?? 0), 0).toLocaleString()}`)
console.log(`with coords  : ${rides.filter((d) => d.toCoords).length}/${rides.length}`)
console.log(`need review  : ${review.length}`)

if (problems.length) {
  console.log('\nvalidation against the PDF\'s own totals:')
  for (const p of problems) console.log(`  ✗ ${p}`)
} else {
  console.log('\n✓ every stage reconciles with the totals printed in the PDF')
}

if (problems.length && !force) {
  console.error('\nRefusing to write. Fix the parser, or pass --force to write anyway.')
  process.exit(1)
}

const out = path.join(ROOT, 'src', 'data', 'itinerary.json')
fs.writeFileSync(
  out,
  `${JSON.stringify({ year: START_YEAR, stages, days }, null, 2)}\n`,
)
console.log(`\nwrote ${path.relative(ROOT, out)}`)
