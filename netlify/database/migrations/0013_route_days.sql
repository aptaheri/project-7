-- The route as it now stands, as opposed to the route he set out with.
--
-- src/data/itinerary.json stays exactly where it is and keeps its job: it is
-- the plan, 467 days written before he left, and it is what "one day behind
-- schedule" is measured against. A schedule that moves to match reality can
-- never report drift, which is why the two are separate things rather than one
-- thing that gets edited.
--
-- This table is what actually happened and what he intends next, and John
-- writes it himself from the road. The night he stopped twelve miles short of
-- Mende, the only record was a text message that sat unread in another timezone
-- until after the next morning's email had gone out saying he was somewhere
-- else. Only days he has changed appear here.
create table if not exists route_days (
  date          date primary key,
  kind          text not null,               -- ride | rest | travel | other
  from_place    text,
  to_place      text,
  miles         double precision,            -- his number; wins over the road's
  note          text,
  from_lon      double precision,
  from_lat      double precision,
  to_lon        double precision,
  to_lat        double precision,
  cycling_miles double precision,            -- what Mapbox makes of riding it
  route_coords  jsonb,                       -- the cycling line, for map and email
  needs_review  boolean not null default false,
  updated_by    text,                        -- which owner, for the record
  updated_at    timestamptz not null default now()
);

-- The distance sentence is written about a specific number of miles — "today's
-- 114 km covered more than a third of the Stevenson Trail". When John corrects
-- a day's distance the fact stays true and that sentence quietly becomes wrong,
-- so the number it was written about is recorded and checked.
alter table destination_facts add column if not exists distance_miles double precision;
