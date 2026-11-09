import { runSafetyCheck } from '../lib/safety.mts'

/**
 * The safety check, on a schedule. Everything it decides lives in
 * lib/safety.mts, which the owner's dry run in email-admin shares.
 *
 * Every fifteen minutes is cheaper than it sounds. At night it stops on the
 * plan, without a connection. By day the database is already awake — his phone
 * posts a fix every few minutes and wakes it — so a check costs a few indexed
 * reads, except in exactly the case it exists for, when the fixes have stopped.
 */
export default async function handler(): Promise<Response> {
  try {
    const outcome = await runSafetyCheck()
    console.log('safety-check:', JSON.stringify(outcome, (k, v) => (k === 'preview' ? undefined : v)))
    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('safety-check failed:', error)
    return new Response(null, { status: 500 })
  }
}

export const config = {
  schedule: '2,17,32,47 * * * *',
}
