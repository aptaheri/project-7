declare module 'tz-lookup' {
  /** Returns the IANA timezone name containing the given coordinates. */
  export default function tzLookup(latitude: number, longitude: number): string
}
