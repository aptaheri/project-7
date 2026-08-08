import { timingSafeEqual } from 'node:crypto'

/** Length-safe, constant-time string comparison. */
export function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

interface Credential {
  user: string
  pass: string
}

/**
 * Every accepted phone.
 *
 * OwnTracks sends its UserID as the Basic auth username, and that UserID also
 * becomes part of the topic that identifies the rider. So each rider needs
 * their own username, or their fixes are rejected with a 401 that the app
 * silently queues and retries forever.
 *
 * OWNTRACKS_CREDENTIALS holds `user:pass` pairs, comma separated.
 * OWNTRACKS_USER / OWNTRACKS_PASS remain valid so an existing phone keeps
 * working without being reconfigured.
 */
function credentials(): Credential[] {
  const list: Credential[] = []

  const user = process.env.OWNTRACKS_USER
  const pass = process.env.OWNTRACKS_PASS
  if (user && pass) list.push({ user, pass })

  for (const entry of (process.env.OWNTRACKS_CREDENTIALS ?? '').split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf(':')
    if (separator === -1) continue
    const u = trimmed.slice(0, separator).trim()
    const p = trimmed.slice(separator + 1).trim()
    if (u && p) list.push({ user: u, pass: p })
  }

  return list
}

/**
 * Verifies HTTP Basic credentials against any configured rider.
 * Returns a 401 Response when the request should be rejected, else null.
 */
export function checkBasicAuth(req: Request): Response | null {
  const accepted = credentials()

  if (accepted.length === 0) {
    console.error('No OwnTracks credentials are configured')
    return json({ error: 'server not configured' }, 500)
  }

  const unauthorized = () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Basic realm="owntracks", charset="UTF-8"',
        'cache-control': 'no-store',
      },
    })

  const header = req.headers.get('authorization')
  if (!header?.startsWith('Basic ')) return unauthorized()

  let decoded: string
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
  } catch {
    return unauthorized()
  }

  const separator = decoded.indexOf(':')
  if (separator === -1) return unauthorized()

  const user = decoded.slice(0, separator)
  const pass = decoded.slice(separator + 1)

  // Every candidate is checked without short-circuiting, so neither timing nor
  // early exit reveals which username exists or which half of a pair failed.
  let matched = false
  for (const candidate of accepted) {
    const userOk = secretsMatch(user, candidate.user)
    const passOk = secretsMatch(pass, candidate.pass)
    if (userOk && passOk) matched = true
  }

  if (!matched) {
    // A rejected phone retries silently forever, so without this line a
    // mistyped credential is invisible from both ends. The username is not a
    // secret; the password is never logged.
    console.warn(`owntracks auth rejected for username="${user}"`)
    return unauthorized()
  }

  return null
}
