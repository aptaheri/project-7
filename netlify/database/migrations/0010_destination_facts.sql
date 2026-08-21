-- Destination lines written at send time rather than by hand.
--
-- The hand-written table in src/data/destination-facts.json covers 33 of the
-- 354 places this route stops at, so nine mornings in ten the email opened with
-- nothing. The rest are now generated when the email is sent, from a web search
-- rather than from recall, and stored here.
--
-- Stored for three reasons: the same sentence should not be paid for twice (a
-- hundred days of this trip are rest days in the town he reached the night
-- before), it should not be re-invented differently on the second morning, and
-- a sentence that turns out to be wrong needs to be findable after the fact.
--
-- Hand-written entries always win over anything in this table.
create table if not exists destination_facts (
  destination text primary key,
  fact        text not null,
  model       text not null,      -- which model wrote it, for when one is retired
  created_at  timestamptz not null default now()
);
