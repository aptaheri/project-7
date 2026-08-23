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
          first_name text,
          last_name  text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          granted_by text
        )
      `
      // The table above already exists in production, where `create table if not
      // exists` is a no-op and would leave the new columns missing. Adding them
      // here rather than only in netlify/database/migrations means a deploy
      // heals its own schema — nobody has to find the connection string and run
      // a migration by hand before the code that needs the column ships.
      await sql`alter table viewers add column if not exists first_name text`
      await sql`alter table viewers add column if not exists last_name text`

      // Generated destination lines, kept so the same place is never invented
      // twice and so a sentence that turns out to be wrong can be found again.
      await sql`
        create table if not exists destination_facts (
          destination text primary key,
          fact        text not null,
          model       text not null,
          created_at  timestamptz not null default now()
        )
      `
      // A sentence putting the day's distance in terms of the place, written
      // alongside the fact. Older rows have none and fall back to arithmetic.
      await sql`alter table destination_facts add column if not exists distance_line text`
      // Which brief the row was written to, so a change of shape replaces the
      // old lines instead of leaving two kinds of email going out.
      await sql`alter table destination_facts add column if not exists format_version int not null default 1`
      // How many times the model has been asked about this place and answered
      // that it had nothing. A row can exist with no fact at all: that is the
      // record of having tried, so it is not tried forever.
      await sql`alter table destination_facts add column if not exists attempts int not null default 0`
      await sql`alter table destination_facts add column if not exists declined_at timestamptz`
      await sql`alter table destination_facts alter column fact drop not null`

      // Finished days, computed once and then read back rather than derived
      // from the whole history on every poll. Keyed by mode so the owner's
      // test view cannot contaminate the real numbers.
      await sql`
        create table if not exists day_rollups (
          local_date    date not null,
          mode          text not null,
          zone          text not null,
          distance_m    double precision not null,
          elapsed_s     double precision not null,
          fixes         int not null,
          start_lon     double precision not null,
          start_lat     double precision not null,
          end_lon       double precision not null,
          end_lat       double precision not null,
          gain_m        double precision not null,
          net_m         double precision,
          high_m        double precision,
          low_m         double precision,
          reconstructed boolean not null default false,
          computed_at   timestamptz not null default now(),
          primary key (local_date, mode)
        )
      `
      // The drawn line for every finished day, already thinned. One row per
      // mode: reading 500 days of history should be one lookup, not a scan.
      await sql`
        create table if not exists trail_cache (
          mode          text primary key,
          through_date  date not null,
          points        jsonb not null,
          seen_received timestamptz not null,
          computed_at   timestamptz not null default now()
        )
      `
      // Serves both the newest-fix watermark and every "since this instant"
      // range scan. The plain tst index cannot skip the other source.
      await sql`
        create index if not exists locations_source_tst_idx on locations (source, tst desc)
      `
      // Fixes for a past day can arrive late — OwnTracks replays what it queued
      // during a gap in coverage. This is how a rollup finds out it is stale
      // without re-reading the day it summarises.
      await sql`
        create index if not exists locations_received_at_idx on locations (received_at)
      `
    })()
    schemaReady.catch(() => {
      schemaReady = null
    })
  }
  return schemaReady
}
