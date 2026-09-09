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
 * The fortnight ahead, on the live map.
 *
 * The same red as the route, because it means the same thing — this is what he
 * intends to ride, and giving it its own hue would invent a third category
 * where there are only two. What separates it from today's leg is emphasis:
 * today is drawn firmly, the days after it fade back, and a day nobody has
 * looked up a road for is dashed rather than solid.
 */
export const AHEAD_RED = ROUTE_RED

// Reconstructed riding used to have a paler blue of its own, drawn dashed, to
// mark it as a different kind of evidence. It looked like a fault rather than a
// distinction — a broken line at the start of the journey — and the numbers
// still say which is which under Total. He rode those miles; the map now says
// so in the same blue as the rest.
