import { runDailyEmail } from '../lib/daily.mts'

/**
 * The morning email, on a schedule.
 *
 * Runs often because it cannot know in advance which half-hour he sets off in,
 * and because he crosses timezones — "morning" moves. Nearly every run stops at
 * the first gate having done one cheap query; the decision to send lives in
 * runDailyEmail, which the owner-facing endpoint shares so that a dry run
 * exercises exactly the code that sends.
 */
export default async function handler(): Promise<Response> {
  try {
    const outcome = await runDailyEmail()
    console.log('daily-email:', JSON.stringify(outcome, (k, v) => (k === 'preview' ? undefined : v)))
    return new Response(null, { status: 204 })
  } catch (error) {
    console.error('daily-email failed:', error)
    return new Response(null, { status: 500 })
  }
}

// Half-hourly: the function cannot know which half-hour he sets off in, and
// "morning" moves as he crosses timezones. Typed loosely because the site does
// not depend on @netlify/functions — Netlify reads this shape either way.
export const config = {
  schedule: '*/30 * * * *',
}
