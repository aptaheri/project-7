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

      // How somebody proved they are who they say, per provider.
      //
      // Access is granted to an *identity*, not to a string. An email address
      // is not proof of anything: Microsoft lets any tenant set a user's email
      // attribute to whatever it likes and issues no email_verified claim at
      // all, so a token claiming a viewer's address is a claim and nothing
      // more. Keying access on the address would hand the live map to anyone
      // willing to spend ten minutes creating a tenant.
      //
      // So the subject — Google's `sub`, Microsoft's `oid`+`tid`, or the
      // address a magic link was actually delivered to and clicked from — is
      // what an owner approves and what a session is issued against. The email
      // beside it is what the owner reads when deciding, and how the daily
      // mail reaches them.
      await sql`
        create table if not exists auth_identities (
          provider   text not null,
          subject    text not null,
          email      text not null,
          first_name text,
          last_name  text,
          created_at timestamptz not null default now(),
          last_seen  timestamptz not null default now(),
          primary key (provider, subject)
        )
      `
      // Every identity for one person, for the sharing page and for deciding
      // which button to offer them first.
      await sql`
        create index if not exists auth_identities_email_idx on auth_identities (email)
      `

      // One-time sign-in links, for everybody whose mail is neither Google's
      // nor Microsoft's — which on the addresses actually on this list is most
      // of them.
      //
      // The token is stored as a SHA-256 hash, never in the clear. A leaked
      // table of live tokens is a leaked set of sessions; a leaked table of
      // hashes is not, and nothing here ever needs the original back — a link
      // is checked by hashing what arrives and looking for the result.
      await sql`
        create table if not exists magic_link_tokens (
          token_hash text primary key,
          email      text not null,
          created_at timestamptz not null default now(),
          expires_at timestamptz not null,
          used_at    timestamptz
        )
      `
      // Expiry is the hot column: every redemption asks whether this hash is
      // live, and the sweep asks which have died.
      await sql`
        create index if not exists magic_link_tokens_expires_idx
          on magic_link_tokens (expires_at)
      `

      // Which way in worked last time, so a returning viewer is offered that
      // one first rather than being asked again. Null until they get in once.
      await sql`alter table viewers add column if not exists last_provider text`

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
      // The mileage the distance sentence was written about. When the day's
      // distance changes, the sentence is about the wrong number and has to go.
      await sql`alter table destination_facts add column if not exists distance_miles double precision`

      // The route as it now stands — see lib/route.mts. Only days he has
      // changed live here; the rest are the plan in src/data/itinerary.json.
      await sql`
        create table if not exists route_days (
          date          date primary key,
          kind          text not null,
          from_place    text,
          to_place      text,
          miles         double precision,
          note          text,
          from_lon      double precision,
          from_lat      double precision,
          to_lon        double precision,
          to_lat        double precision,
          cycling_miles double precision,
          route_coords  jsonb,
          needs_review  boolean not null default false,
          updated_by    text,
          updated_at    timestamptz not null default now()
        )
      `

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
