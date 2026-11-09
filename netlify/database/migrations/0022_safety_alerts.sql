-- Safety alerts to the owners: no fixes, or no movement, mid-ride and short
-- of the night's town. One row per episode, resolved when he turns up.
--
-- Mirrors ensureSchema in netlify/lib/db.mts, which is what actually runs on
-- deploy. A new file rather than an edit to an older one: these are applied on
-- deploy and checksummed, and changing one that has already run fails the
-- build.
create table if not exists safety_alerts (
  id          bigserial primary key,
  local_date  date not null,
  kind        text not null,
  lat         double precision not null,
  lon         double precision not null,
  last_fix    timestamptz not null,
  detail      text,
  sent_at     timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists safety_alerts_local_date on safety_alerts (local_date);
