import { neon } from '@neondatabase/serverless'

type Sql = ReturnType<typeof neon>

let client: Sql | null = null
let schemaReady: Promise<void> | null = null

export function db(): Sql {
  if (!client) {
    // NETLIFY_DATABASE_URL is injected by the Netlify DB (Neon) extension.
    // DATABASE_URL is checked first so a manually set value can override it.
    const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL
    if (!url) {
      throw new Error('Neither DATABASE_URL nor NETLIFY_DATABASE_URL is set')
    }
    client = neon(url)
  }
  return client
}

/**
 * Applies db/schema.sql. Runs at most once per warm instance; a failure clears
 * the cached promise so the next request retries rather than staying broken.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    const sql = db()
    schemaReady = (async () => {
      await sql`
        create table if not exists locations (
          id          bigserial primary key,
          device      text not null,
          tst         timestamptz not null,
          lat         double precision not null,
          lon         double precision not null,
          acc         double precision,
          alt         double precision,
          vel         double precision,
          cog         double precision,
          batt        smallint,
          bs          smallint,
          conn        text,
          tid         text,
          raw         jsonb not null,
          received_at timestamptz not null default now(),
          constraint locations_device_tst_key unique (device, tst)
        )
      `
      await sql`create index if not exists locations_tst_idx on locations (tst desc)`
    })()
    schemaReady.catch(() => {
      schemaReady = null
    })
  }
  return schemaReady
}
