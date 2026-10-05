-- How many times each viewer has opened the tracker, by day.
--
-- Mirrors ensureSchema in netlify/lib/db.mts, which is what actually runs on
-- deploy. A new file rather than an edit to an older one: these are applied on
-- deploy and checksummed, and changing one that has already run fails the
-- build.
--
-- Written once a session from track-history.mts, not on every 30-second poll
-- from track-feed.mts — see lib/visits.mts.
create table if not exists track_visits (
  email      text not null,
  local_date date not null,
  visits     int not null default 0,
  last_seen  timestamptz not null default now(),
  primary key (email, local_date)
);
