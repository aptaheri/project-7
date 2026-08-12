/**
 * preview-email.mjs
 *
 * Renders the daily email to a file so it can be looked at before anything is
 * sent. Uses a real leg from the itinerary rather than invented data.
 *
 *   node scripts/preview-email.mjs [YYYY-MM-DD]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'email-preview.html')

const bundle = path.join(ROOT, 'node_modules', '.tmp-email.mjs')
fs.mkdirSync(path.dirname(bundle), { recursive: true })
execFileSync('npx', [
  '--yes', 'esbuild@0.24.0', 'netlify/lib/email.mts',
  '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`,
], { cwd: ROOT, stdio: 'ignore' })

const { buildDailyEmail } = await import(bundle)
const itinerary = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/itinerary.json'), 'utf8'))

const wanted = process.argv[2]
const leg =
  itinerary.days.find((d) => d.kind === 'ride' && d.date === wanted && d.toCoords) ??
  itinerary.days.find((d) => d.kind === 'ride' && d.toCoords)

// The token is already public in the client bundle; this only builds a preview.
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

const { subject, html, text } = buildDailyEmail({
  dayNumber: leg.day,
  from: leg.from,
  to: leg.to,
  plannedMiles: leg.miles,
  dateLabel: new Date(`${leg.date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }),
  fromCoords: leg.fromCoords,
  toCoords: leg.toCoords,
  milesSoFar: 6.4,
  liveUrl: 'https://project7.bike/track',
  unsubscribeUrl: 'https://project7.bike/api/unsubscribe?t=example',
  mapboxToken: env.VITE_MAPBOX_TOKEN ?? null,
})

fs.writeFileSync(OUT, html)
console.log(`leg      : ${leg.date}  ${leg.from} -> ${leg.to}  (${leg.miles} mi)`)
console.log(`subject  : ${subject}`)
console.log(`html     : ${(html.length / 1024).toFixed(1)} KB -> ${path.relative(ROOT, OUT)}`)
console.log()
console.log('--- plain text version ---')
console.log(text)
