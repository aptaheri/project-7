-- Cycling geometry for the days ahead that John has not edited.
--
-- Mirrors ensureSchema in netlify/lib/db.mts, which is what actually runs on
-- deploy. This file is the record.
--
-- Kept out of route_days on purpose: a row there means "he changed this", and
-- both the editor and the drift figure read it that way, so caching a line in
-- one would relabel the plan as edited. The endpoints live beside the line so a
-- reroute invalidates it — same date, different towns, recompute.
create table if not exists route_geometry (
  date        date primary key,
  from_lon    double precision not null,
  from_lat    double precision not null,
  to_lon      double precision not null,
  to_lat      double precision not null,
  coords      jsonb not null,
  computed_at timestamptz not null default now()
);

-- Roads carry the routing rules they were fetched under, so a change to those
-- rules replaces them rather than leaving them to be wrong quietly. Version 1
-- let the cycling profile take ferries, which drew him riding Zadar to Ancona.
alter table route_geometry add column if not exists version int not null default 1;
