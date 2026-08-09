/**
 * Conditions where the rider is: sun times and current weather.
 *
 * Sun times are computed rather than fetched — they are pure astronomy, and an
 * API call for something a formula answers exactly would add a dependency and a
 * failure mode for nothing. Weather genuinely has to be asked for.
 */

export interface LocalConditions {
  sunriseUtc: string | null
  sunsetUtc: string | null
  weather: {
    temperatureC: number
    windKph: number
    windDirection: number
    code: number
  } | null
}

/** Weather changes slowly and every viewer polls; one lookup serves them all. */
const WEATHER_CACHE_MS = 10 * 60 * 1000

const RAD = Math.PI / 180

/**
 * Sunrise and sunset in UTC for a coordinate on a date.
 *
 * The standard NOAA approximation. Returns nulls inside a polar day or night,
 * where the sun does not cross the horizon at all — which Antarctica will hit.
 */
export function sunTimes(lat: number, lon: number, date: Date): {
  sunrise: Date | null
  sunset: Date | null
} {
  // Days since 2000-01-01, counted from local solar noon rather than midnight.
  const julian = date.getTime() / 86_400_000 + 2440587.5
  const n = Math.round(julian - 2451545.0 + 0.0008)

  const meanSolarNoon = n - lon / 360
  const meanAnomaly = (357.5291 + 0.98560028 * meanSolarNoon) % 360
  const center =
    1.9148 * Math.sin(meanAnomaly * RAD) +
    0.02 * Math.sin(2 * meanAnomaly * RAD) +
    0.0003 * Math.sin(3 * meanAnomaly * RAD)
  const eclipticLongitude = (meanAnomaly + center + 180 + 102.9372) % 360

  const solarTransit =
    2451545.0 +
    meanSolarNoon +
    0.0053 * Math.sin(meanAnomaly * RAD) -
    0.0069 * Math.sin(2 * eclipticLongitude * RAD)

  const declination = Math.asin(
    Math.sin(eclipticLongitude * RAD) * Math.sin(23.44 * RAD),
  )

  // -0.833° accounts for refraction and the sun's disc, as NOAA does.
  const cosHourAngle =
    (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) /
    (Math.cos(lat * RAD) * Math.cos(declination))

  if (cosHourAngle > 1 || cosHourAngle < -1) {
    return { sunrise: null, sunset: null }
  }

  const hourAngle = Math.acos(cosHourAngle) / RAD
  const toDate = (jd: number) => new Date((jd - 2440587.5) * 86_400_000)

  return {
    sunrise: toDate(solarTransit - hourAngle / 360),
    sunset: toDate(solarTransit + hourAngle / 360),
  }
}

let weatherCache: { at: number; key: string; value: LocalConditions['weather'] } | null = null

/**
 * Current weather from Open-Meteo, which needs no key.
 *
 * Returns null rather than throwing: the panel should lose one row when the
 * weather service is unreachable, not the whole feed.
 */
async function fetchWeather(
  lat: number,
  lon: number,
): Promise<LocalConditions['weather']> {
  // Rounded so small movements do not miss the cache on every poll.
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`
  if (weatherCache && weatherCache.key === key && Date.now() - weatherCache.at < WEATHER_CACHE_MS) {
    return weatherCache.value
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code'
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = (await res.json()) as {
      current?: {
        temperature_2m?: number
        wind_speed_10m?: number
        wind_direction_10m?: number
        weather_code?: number
      }
    }
    const c = body.current
    if (!c || typeof c.temperature_2m !== 'number') throw new Error('no current weather')

    const value = {
      temperatureC: c.temperature_2m,
      windKph: c.wind_speed_10m ?? 0,
      windDirection: c.wind_direction_10m ?? 0,
      code: c.weather_code ?? 0,
    }
    weatherCache = { at: Date.now(), key, value }
    return value
  } catch (error) {
    console.error('weather lookup failed', error)
    return null
  }
}

export async function localConditions(
  lat: number,
  lon: number,
): Promise<LocalConditions> {
  const { sunrise, sunset } = sunTimes(lat, lon, new Date())
  return {
    sunriseUtc: sunrise?.toISOString() ?? null,
    sunsetUtc: sunset?.toISOString() ?? null,
    weather: await fetchWeather(lat, lon),
  }
}
