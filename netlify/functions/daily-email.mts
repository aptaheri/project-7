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

// Hourly. Half-hourly bought nothing worth having: the email only promises that
// he is on the road, and arriving up to an hour after he sets off still says
// that truthfully. It still gets six attempts inside the send window, and it
// halves the number of times anything runs at all.
//
// Typed loosely because the site does not depend on @netlify/functions —
// Netlify reads this shape either way.
// Seven minutes past, not on the hour. The hour mark stopped firing at the end
// of August — fact-warm kept running on the same deploy while this logged
// nothing at all across three separate hours, so the schedule itself had gone
// stale rather than the function failing. Changing the expression is what
// re-registers it. The minute is arbitrary; that it is a different string is
// the point.
export const config = {
  schedule: '7 * * * *',
}
