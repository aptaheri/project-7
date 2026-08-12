import { neon } from '@neondatabase/serverless'

type Sql = ReturnType<typeof neon>

let client: Sql | null = null
let schemaReady: Promise<void> | null = null

export function db(): Sql {
  if (!client) {
    // Netlify injects the connection string at runtime once @netlify/database
    // is a dependency and the site has been deployed. Their SDK reads
    // NETLIFY_DB_URL while their drizzle scaffold reads NETLIFY_DATABASE_URL,
    // so accept either. DATABASE_URL wins so a manual value can override.
    const url =
      process.env.DATABASE_URL ??
      process.env.NETLIFY_DB_URL ??
      process.env.NETLIFY_DATABASE_URL
    if (!url) {
      // Name the database-ish vars that *are* present — the injected name has
      // changed before, and this turns a silent 500 into an obvious log line.
      const present = Object.keys(process.env)
        .filter((k) => k.includes('DB') || k.includes('DATABASE'))
        .join(', ')
      throw new Error(
        `No connection string: DATABASE_URL, NETLIFY_DB_URL and NETLIFY_DATABASE_URL are all unset. Database-related vars present: ${present || 'none'}`,
      )
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
          source      text not null default 'device',
          raw         jsonb not null,
          received_at timestamptz not null default now(),
          constraint locations_device_tst_key unique (device, tst)
        )
      `
      await sql`create index if not exists locations_tst_idx on locations (tst desc)`
      await sql`
        create table if not exists sent_emails (
          local_date  date not null,
          kind        text not null default 'daily',
          sent_at     timestamptz not null default now(),
          recipients  int not null default 0,
          subject     text,
          primary key (local_date, kind)
        )
      `
      await sql`
        create table if not exists viewers (
          email      text primary key,
          role       text not null default 'pending',
          email_pref text not null default 'daily',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          granted_by text
        )
      `
    })()
    schemaReady.catch(() => {
      schemaReady = null
    })
  }
  return schemaReady
}
