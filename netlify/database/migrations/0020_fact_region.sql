-- A destination with nothing written about it gets a paragraph about the
-- region it sits in, and a place whose question timed out waits its turn.
--
-- Mirrors ensureSchema in netlify/lib/db.mts, which is what actually runs on
-- deploy. A new file rather than an edit to an older one: these are applied on
-- deploy and checksummed, and changing one that has already run fails the
-- build.
alter table destination_facts add column if not exists about_region text;
alter table destination_facts add column if not exists failed_at timestamptz;
