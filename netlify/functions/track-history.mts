import { json } from '../lib/auth.mts'
import { db, ensureSchema } from '../lib/db.mts'
import { requireTrackViewer } from '../lib/gate.mts'
import { testDevices } from '../lib/devices.mts'
import { localDayRange } from '../lib/day.mts'
import { loadHistory } from '../lib/rollups.mts'
import type { DaySummary } from '../lib/rollups.mts'
import tzLookup from 'tz-lookup'

/**
 * The half of the tracker that does not change while you watch it.
 *
 * Every finished day, the line through them, and the reconstructed riding from
 * before the tracker existed. All of it is settled history: it changes when a
 * day ends, which is once a day, against a live feed that changes every time a
 * fix arrives.
 *
 * Sending both together meant re-transmitting the entire journey to move a
 * marker a few hundred metres — about a megabyte of route, every thirty
 * seconds, per viewer, growing for fifteen months. The client fetches this once
 * and again only when the version token in the live feed changes.
 *
 * Behind the same sign-in wall as the live feed: this is a precise record of
 * where he has slept every night, which is exactly what is not public.
 */

interface HistoryPayload {
  version: string
  /** One entry per finished riding day, oldest first. */
  days: DaySummary[]
  /** The route so far, simplified to follow the roads it was ridden on. */
  trail: [number, number][]
  /** Reconstructed riding from before the tracker existed. Drawn dashed. */
  backfillTrail: [number, number][]
  backfillKm: number
  mode: 'production' | 'test'
}

/** Reconstructed riding is fixed; it never needs recomputing. */
let backfillCache: { trail: [number, number][]; km: number } | null = null

/** Keyed by mode so the two views cannot serve each other's history. */
const cache = new Map<string, { version: string; payload: HistoryPayload }>()

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405)

  const gate = await requireTrackViewer(req)
  if (gate instanceof Response) return gate

  const isOwner = gate.role === 'owner'
  const wantsTest = new URL(req.url).searchParams.get('mode') === 'test'
  const mode: 'production' | 'test' = isOwner && wantsTest ? 'test' : 'production'
  const devices = testDevices()
  const isTest = mode === 'test'

  try {
    await ensureSchema()
    const sql = db()

    // Where he is decides which day it is, exactly as the live feed decides it.
    const latest = (await sql`
      select lat, lon from locations
      where (device = any(${devices}::text[])) = ${isTest}::boolean
        and source = 'device'
      order by tst desc
      limit 1
    `) as unknown as { lat: number; lon: number }[]

    if (!latest[0]) {
      return json({
        version: 'empty',
        days: [],
        trail: [],
        backfillTrail: [],
        backfillKm: 0,
        mode,
      } satisfies HistoryPayload)
    }

    let zone: string
    try {
      zone = tzLookup(latest[0].lat, latest[0].lon)
    } catch {
      zone = 'UTC'
    }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date())
    const { start: dayStart } = localDayRange(zone, today)

    const history = await loadHistory({
      sql, zone, mode, devices, isTest, todayStart: dayStart, today,
    })

    // Nothing has changed since this instance last built the answer, and the
    // answer is the largest thing this site sends.
    const cached = cache.get(mode)
    if (cached && cached.version === history.version) return json(cached.payload)

    if (!backfillCache) {
      const backfillRows = (await sql`
        with ordered as (
          select
            tst, lat, lon,
            lag(lat) over (order by tst) as plat,
            lag(lon) over (order by tst) as plon
          from locations
          where source = 'backfill'
        ),
        steps as (
          select
            tst, lat, lon,
            case when plat is null then 0 else
              2 * 6371000 * asin(least(1, sqrt(
                power(sin(radians(lat - plat) / 2), 2) +
                cos(radians(plat)) * cos(radians(lat)) *
                power(sin(radians(lon - plon) / 2), 2)
              )))
            end as step_m
          from ordered
        )
        select lon, lat, sum(step_m) over () as total_m from steps order by tst
      `) as unknown as { lon: number; lat: number; total_m: number }[]

      backfillCache = {
        trail: backfillRows.map((r) => [r.lon, r.lat]),
        km: (backfillRows[0]?.total_m ?? 0) / 1000,
      }
    }

    const payload: HistoryPayload = {
      version: history.version,
      days: history.days,
      trail: history.trail,
      backfillTrail: backfillCache.trail,
      backfillKm: backfillCache.km,
      mode,
    }

    cache.set(mode, { version: history.version, payload })
    return json(payload)
  } catch (error) {
    console.error('track history failed', error)
    return json({ error: 'query failed' }, 500)
  }
}
