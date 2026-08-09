/**
 * One palette for every map on the site.
 *
 * The two lines mean different things and must never be confused: red is the
 * route he intends to ride, blue is ground he has actually covered. Both appear
 * together on the live map, so they cannot share a hue.
 */

/** Planned route. The red from the Project 7 logo. */
export const ROUTE_RED = '#E31A28'

/** Ground actually ridden, and the live position marker. */
export const LIVE_BLUE = '#4285f4'

/**
 * Reconstructed riding from before the tracker existed.
 *
 * A paler blue, and drawn dashed: related to the measured track because he did
 * ride it, but visibly not the same kind of evidence.
 */
export const BACKFILL_BLUE = '#8ab4f8'
