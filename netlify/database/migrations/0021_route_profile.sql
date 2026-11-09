-- Which router drew a day's road: cycling, or driving where John rides the
-- highway a car would take — the Kyzylkum, where the cycling router leaves the
-- A380 for farm tracks along the Turkmen border.
--
-- Mirrors ensureSchema in netlify/lib/db.mts, which is what actually runs on
-- deploy. A new file rather than an edit to an older one: these are applied on
-- deploy and checksummed, and changing one that has already run fails the
-- build.
alter table route_days add column if not exists profile text;
