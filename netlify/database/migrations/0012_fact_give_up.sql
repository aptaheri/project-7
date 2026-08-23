-- A record of having tried and got nothing.
--
-- The model is told to answer with an empty string about a village it cannot
-- verify, and doing so is correct — but nothing was stored when it did, so the
-- next run asked again, and the one after that. A place the model will never
-- have anything for was worth about two cents a run, forever.
--
-- A row with a null fact is that record. It carries the number of attempts and
-- when the last one gave up; after a few, the warmer stops asking. Raising
-- FORMAT_VERSION revives them all, which is right: a new brief is a genuinely
-- different question and deserves a fresh answer.
alter table destination_facts add column if not exists attempts int not null default 0;
alter table destination_facts add column if not exists declined_at timestamptz;
alter table destination_facts alter column fact drop not null;
