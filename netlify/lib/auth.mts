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

/**
 * Verifies HTTP Basic credentials against OWNTRACKS_USER / OWNTRACKS_PASS.
 * Returns a 401 Response when the request should be rejected, else null.
 */
export function checkBasicAuth(req: Request): Response | null {
  const expectedUser = process.env.OWNTRACKS_USER
  const expectedPass = process.env.OWNTRACKS_PASS

  if (!expectedUser || !expectedPass) {
    console.error('OWNTRACKS_USER / OWNTRACKS_PASS are not configured')
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

  // Both comparisons always run so timing does not reveal which half failed.
  const userOk = secretsMatch(user, expectedUser)
  const passOk = secretsMatch(pass, expectedPass)
  return userOk && passOk ? null : unauthorized()
}
