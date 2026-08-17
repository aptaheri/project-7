/**
 * Devices whose fixes are test data. Production is defined as everything NOT
 * listed here, so a new rider's phone counts as real from its first fix — no
 * configuration needed on his side and no way for day one to land in test.
 *
 * Shared rather than duplicated: the live feed and the public country line have
 * to agree on what counts as real riding, or a test fix could put him in the
 * wrong country on the homepage while the tracker showed him in the right one.
 */
export function testDevices(): string[] {
  return (process.env.TRACK_TEST_DEVICES ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)
}
