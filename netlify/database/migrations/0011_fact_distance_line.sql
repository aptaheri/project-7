-- A second generated line, and a version stamp on both.
--
-- The destination line grew from one sentence to two, and gained a companion:
-- a sentence putting the day's mileage in terms of that place rather than the
-- generic arithmetic comparisons in email.mts. Both are written by the same
-- call in fact-warm.mts.
--
-- format_version is what makes the change take effect on places already
-- warmed. Version 1 rows are a single sentence with no distance line; the
-- warmer replaces any row below the current version rather than leaving two
-- shapes of email going out depending on when a place happened to come up.
alter table destination_facts add column if not exists distance_line text;
alter table destination_facts add column if not exists format_version int not null default 1;
