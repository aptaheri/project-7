/**
 * fill-coords.mjs
 *
 * Fills in the coordinates the plan never had.
 *
 * 131 of the places in `src/data/itinerary.json` carry a name and no position —
 * Petrovac, Beypazari, Pinarlar and a long tail through Central Asia and South
 * America. A day with no coordinate cannot be routed, cannot be drawn, and
 * cannot even be given a marker, which is why the live map has holes in it: the
 * three days around Petrovac vanish and take the line from Split to Elbasan
 * with them.
 *
 * This is not a route change. Names, distances and kinds are untouched — the
 * plan still says what it always said, and `daysFromPlan` still measures
 * against it. Only the missing halves are filled.
 *
 * Nothing is trusted blindly. Every lookup is biased toward the nearest day
 * that does have a position, and the answer is rejected unless it lands close
 * enough to be the place the plan means. A refused day keeps its null and is
 * listed at the end, because a wrong coordinate is far worse than a gap: a gap
 * draws nothing, a wrong one draws him riding somewhere he is not.
 *
 * Usage:
 *   node scripts/fill-coords.mjs            # report only, writes nothing
 *   node scripts/fill-coords.mjs --write    # apply
 *
 * Requires VITE_MAPBOX_TOKEN.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WRITE = process.argv.includes('--write')
const FILE = resolve('src/data/itinerary.json')

const token = process.env.VITE_MAPBOX_TOKEN
if (!token) {
  console.error('VITE_MAPBOX_TOKEN is not set')
  process.exit(1)
}

const KM_PER_MILE = 1.609344

/**
 * Where a place has to sit to be believed: on the way.
 *
 * Distance from one neighbour is not enough, and Petrovac proves it. The plan
 * goes Dubrovnik to Petrovac to Elbasan, down the Montenegro coast. Mapbox
 * offers Bosanski Petrovac, inland Bosnia — 250 km from Dubrovnik, which a
 * plain radius happily allows, and completely the wrong way.
 *
 * So the test is the corridor between the known day before and the known day
 * after, which is the same question `currentLeg` asks about the rider: does
 * going via this point cost much more than going straight? Bosanski Petrovac
 * turns a 224 km gap into a 750 km detour and is refused. Petrovac in
 * Montenegro makes it 239 km and is not.
 */
const CORRIDOR_SLACK = 1.6

/**
 * How far apart the two known days may be for the corridor to mean anything.
 *
 * Where the plan flies, the nearest known day either side can be nine thousand
 * kilometres apart, and a corridor that wide admits an entire continent: it
 * accepted Shirin in Afghanistan for a village in Uzbekistan, because on a
 * 9,400 km line almost anywhere is "on the way". Past this the test has no
 * force and the honest answer is to leave the day empty and say so.
 */
const CORRIDOR_MAX_KM = 600

const EARTH_KM = 6371
function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b[1] - a[1])
  const dLon = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Names in the file arrive with a space dropped into the middle — "Tortug a",
 * "Anas táci o", "Bharat pur" — and the same place usually appears correctly
 * spelled on another day. Try what is written first, then the closed-up form.
 */
function variants(name) {
  const closed = name.replace(/\s+/g, '')
  return closed !== name ? [name, closed] : [name]
}

/** Places that are not places, and must never be guessed at. */
const NOT_A_PLACE = /^(day \d|.*flight.*|asia|africa|south pole|union glacier)$/i

/**
 * Several candidates, not one.
 *
 * The top hit is frequently the biggest place of that name rather than the one
 * on this road — ask for Petrovac near Dubrovnik and Bosanski Petrovac comes
 * back first. The caller keeps the first that sits on the corridor, which is a
 * far better tiebreaker than population.
 */
async function geocode(name, near) {
  const found = []
  for (const q of variants(name)) {
    const url =
      `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}` +
      `&types=place,locality,district&limit=5&access_token=${token}` +
      (near ? `&proximity=${near[0]},${near[1]}` : '')
    const res = await fetch(url)
    if (!res.ok) continue
    const body = await res.json()
    for (const f of body.features ?? []) {
      if (f?.geometry?.coordinates) {
        found.push({ coords: f.geometry.coordinates, label: f.properties?.full_address ?? q })
      }
    }
    if (found.length) break
  }
  return found
}

const data = JSON.parse(readFileSync(FILE, 'utf8'))
const days = data.days

/** The nearest known position before this day, and the nearest after it. */
function neighbours(i) {
  let before = null
  for (let j = i - 1; j >= 0; j -= 1) {
    const c = days[j].toCoords ?? days[j].fromCoords
    if (c) { before = { coords: c, daysApart: i - j }; break }
  }
  let after = null
  for (let j = i + 1; j < days.length; j += 1) {
    const c = days[j].fromCoords ?? days[j].toCoords
    if (c) { after = { coords: c, daysApart: j - i }; break }
  }
  return { before, after }
}

/**
 * Whether going via this point is a detour or a different journey.
 *
 * With a known day on both sides the corridor decides it. With only one side —
 * the very start of the trip, or a run of unknowns at the end — fall back to
 * how far a bicycle could plausibly have got in the days between.
 */
function believable(candidate, { before, after }, plannedMiles) {
  if (before && after) {
    const direct = haversineKm(before.coords, after.coords)
    if (direct > CORRIDOR_MAX_KM) {
      return { ok: false, why: `neighbours ${Math.round(direct)} km apart — nothing to check against` }
    }
    const via = haversineKm(before.coords, candidate) + haversineKm(candidate, after.coords)
    // A short direct line needs absolute slack too, or two towns an hour apart
    // would reject anything not exactly between them.
    const allowed = Math.max(direct * CORRIDOR_SLACK, direct + 120)
    return { ok: via <= allowed, why: `${Math.round(via)} km via, ${Math.round(direct)} km direct` }
  }
  const side = before ?? after
  if (!side) return { ok: true, why: 'nothing to compare against' }
  const away = haversineKm(side.coords, candidate)
  const limit = Math.max(plannedMiles ? plannedMiles * KM_PER_MILE * 2 : 0, 200 * side.daysApart)
  return { ok: away <= limit, why: `${Math.round(away)} km out, limit ${Math.round(limit)}` }
}

// One lookup per name, not per day: a place is usually both the end of one day
// and the start of the next, and asking twice would be paying twice to disagree
// with ourselves.
const resolved = new Map()
const refused = []
const skipped = []
let filled = 0

for (let i = 0; i < days.length; i += 1) {
  const day = days[i]
  for (const side of ['from', 'to']) {
    const name = day[side]
    const key = `${side}Coords`
    if (!name || day[key]) continue
    if (NOT_A_PLACE.test(name.trim())) {
      if (!skipped.includes(name)) skipped.push(name)
      continue
    }

    if (!resolved.has(name)) {
      const near = neighbours(i)
      const hint = near.before?.coords ?? near.after?.coords
      const candidates = await geocode(name, hint)
      if (candidates.length === 0) {
        resolved.set(name, null)
        refused.push({ name, why: 'no result' })
      } else {
        // The first that is on the way, rather than the first Mapbox happens to
        // rank highest — which is usually the largest town of that name.
        let taken = null
        let lastWhy = ''
        for (const c of candidates) {
          const verdict = believable(c.coords, near, day.miles)
          lastWhy = `${verdict.why} (${c.label})`
          if (verdict.ok) { taken = { ...c, why: verdict.why }; break }
        }
        if (!taken) {
          resolved.set(name, null)
          refused.push({ name, why: `none of ${candidates.length} on the corridor — best was ${lastWhy}` })
        } else {
          resolved.set(name, taken.coords)
          console.log(`  ${name} → ${taken.label} — ${taken.why}`)
        }
      }
    }

    const coords = resolved.get(name)
    if (coords) {
      day[key] = coords
      filled += 1
    }
  }
}

console.log(`\nfilled ${filled} coordinate(s) across ${resolved.size} place(s)`)
if (skipped.length) console.log(`not places, left alone: ${skipped.join(', ')}`)
if (refused.length) {
  console.log(`\nrefused ${refused.length}, left null rather than guessed:`)
  for (const r of refused) console.log(`  ${r.name} — ${r.why}`)
}

if (WRITE) {
  writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`)
  console.log(`\nwritten to ${FILE}`)
} else {
  console.log('\nnothing written — pass --write to apply')
}
