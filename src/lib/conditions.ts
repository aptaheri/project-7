/** Formatting for the local conditions where the rider is. */

/** WMO weather codes, as Open-Meteo returns them. */
const WEATHER_CODES: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function weatherDescription(code: number): string {
  return WEATHER_CODES[code] ?? 'Unknown'
}

export function compass(degrees: number): string {
  return COMPASS[Math.round(degrees / 22.5) % 16]
}

export function fahrenheit(celsius: number): string {
  return `${Math.round(celsius * 9 / 5 + 32)}°F`
}

export function mph(kph: number): string {
  return `${Math.round(kph * 0.621371)} mph`
}

/** The wall-clock time in a given IANA zone. */
export function timeIn(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(at)
}

export function dateIn(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(at)
}

/** Bearing from one coordinate to another, in degrees from north. */
export function bearing(from: [number, number], to: [number, number]): number {
  const rad = Math.PI / 180
  const dLon = (to[0] - from[0]) * rad
  const lat1 = from[1] * rad
  const lat2 = to[1] * rad
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (Math.atan2(y, x) / rad + 360) % 360
}

/**
 * The wind as a cyclist experiences it, given the way he is pointing.
 *
 * Wind direction is reported as where the wind comes FROM, so a wind from the
 * same bearing he is travelling towards is a headwind. The component along his
 * direction of travel is what he feels; the rest pushes him sideways.
 */
export function windRelativeToHeading(
  windFromDegrees: number,
  windKph: number,
  headingDegrees: number,
): { label: string; kph: number } {
  let offset = Math.abs(windFromDegrees - headingDegrees) % 360
  if (offset > 180) offset = 360 - offset

  const along = windKph * Math.cos(offset * (Math.PI / 180))

  if (offset <= 45) return { label: 'Headwind', kph: Math.abs(along) }
  if (offset >= 135) return { label: 'Tailwind', kph: Math.abs(along) }
  return { label: 'Crosswind', kph: windKph * Math.sin(offset * (Math.PI / 180)) }
}

/**
 * How much daylight is left, or how long until the sun comes up.
 *
 * Returns null outside a normal day/night cycle — polar day and night both
 * produce no sunrise or sunset at all, which Antarctica will reach.
 */
export function daylight(
  sunriseUtc: string | null,
  sunsetUtc: string | null,
  now = new Date(),
): { label: string; value: string } | null {
  if (!sunriseUtc || !sunsetUtc) return null

  const sunrise = new Date(sunriseUtc)
  const sunset = new Date(sunsetUtc)
  const format = (ms: number) => {
    const minutes = Math.max(0, Math.round(ms / 60000))
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  if (now < sunrise) return { label: 'Until sunrise', value: format(sunrise.getTime() - now.getTime()) }
  if (now < sunset) return { label: 'Daylight left', value: format(sunset.getTime() - now.getTime()) }
  return { label: 'Since sunset', value: format(now.getTime() - sunset.getTime()) }
}

export interface RestingInput {
  /** True when fixes are still arriving; nothing to say if he is moving. */
  isLive: boolean
  /** Open-Meteo's reading for his location, when weather resolved. */
  isDay: boolean | null | undefined
  sunriseUtc: string | null | undefined
  sunsetUtc: string | null | undefined
  distanceTodayKm: number
  leg: { kind: 'ride' | 'rest'; from: string | null; to: string } | null
  now?: number
}

/**
 * "Asleep in Logroño", when that is what the silence means.
 *
 * A gap in the fixes at two in the morning where he is says he is asleep, not
 * that anything has broken. For anyone checking from a US timezone — where his
 * night is their afternoon — it answers the question they actually have, which
 * is why nothing is moving.
 *
 * Returns null whenever the silence is not obviously bedtime, so the panel
 * falls back to describing the tracker rather than guessing at the rider.
 */
export function restingLabel(input: RestingInput): string | null {
  if (input.isLive) return null

  const night =
    input.isDay === false
      ? true
      : input.isDay === true
        ? false
        : // No weather to ask, so fall back to the sun times we compute. Null
          // means polar day or night, where this cannot be answered at all and
          // is better left unsaid — Antarctica will hit exactly that.
          input.sunriseUtc && input.sunsetUtc
          ? (() => {
              const now = input.now ?? Date.now()
              return now < Date.parse(input.sunriseUtc!) || now > Date.parse(input.sunsetUtc!)
            })()
          : false

  if (!night) return null

  // Which town he is in: the one he is resting at, or — when he has not set off
  // yet — the one today's leg starts from. Mid-route there is no town to name.
  const notStarted = input.distanceTodayKm < 3
  const town =
    input.leg?.kind === 'rest'
      ? input.leg.to
      : notStarted
        ? (input.leg?.from ?? null)
        : null

  return town ? `Asleep in ${town}` : 'Probably asleep'
}
