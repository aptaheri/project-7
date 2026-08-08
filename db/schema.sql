-- Location breadcrumbs posted by the OwnTracks app.
-- The ingest function applies this automatically on cold start; this file is
-- here for reference and for setting the database up by hand.

create table if not exists locations (
  id          bigserial primary key,
  device      text not null,              -- OwnTracks topic, e.g. owntracks/<user>/<device>
  tst         timestamptz not null,       -- fix time reported by the phone
  lat         double precision not null,
  lon         double precision not null,
  acc         double precision,           -- horizontal accuracy, metres
  alt         double precision,           -- altitude, metres
  vel         double precision,           -- speed, km/h
  cog         double precision,           -- course over ground, degrees
  batt        smallint,                   -- battery percentage
  bs          smallint,                   -- battery status (0 unknown, 1 unplugged, 2 charging, 3 full)
  conn        text,                       -- w=wifi, m=mobile, o=offline
  tid         text,                       -- two-character tracker id
  raw         jsonb not null,             -- full payload, so nothing is lost
  received_at timestamptz not null default now(),

  -- The phone replays queued points after a gap in coverage, so the same fix
  -- can arrive more than once. This makes re-delivery a no-op.
  constraint locations_device_tst_key unique (device, tst)
);

create index if not exists locations_tst_idx on locations (tst desc);
