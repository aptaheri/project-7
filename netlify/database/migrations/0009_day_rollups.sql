-- Finished days, summarised once instead of re-derived on every poll.
--
-- The live feed answered every request by reading the whole locations table:
-- six window-function passes over every fix ever recorded, once per arriving
-- fix, on a database billed by the hour it stays awake. That is a cost which
-- grows with the length of the trip — by Antarctica each poll would have been
-- sifting half a million rows to redraw a line unchanged since Portugal.
--
-- Yesterday cannot change, so it is computed when it ends and read back as
-- numbers. Only today is derived from fixes.
create table if not exists day_rollups (
  local_date    date not null,
  mode          text not null,              -- 'production' or the owner's test view
  zone          text not null,              -- the timezone the day was bucketed in
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
);

-- The drawn line for everything before today, thinned once. One row per mode:
-- reading five hundred days of history should be a lookup, not a scan.
create table if not exists trail_cache (
  mode          text primary key,
  through_date  date not null,
  points        jsonb not null,
  seen_received timestamptz not null,       -- newest arrival the line accounts for
  computed_at   timestamptz not null default now()
);

-- Serves both the newest-fix watermark and every "since this instant" range
-- scan; the plain tst index cannot skip the other source.
create index if not exists locations_source_tst_idx on locations (source, tst desc);

-- Fixes for a past day can arrive late — OwnTracks replays what it queued
-- during a gap in coverage. This is how a summary finds out it is stale without
-- re-reading the day it summarises.
create index if not exists locations_received_at_idx on locations (received_at);
