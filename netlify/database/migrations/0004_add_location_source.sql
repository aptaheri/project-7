-- Distinguishes measured fixes from reconstructed ones.
--
-- Everything recorded by a phone is 'device'. Backfilled riding — inferred from
-- the planned route and his own account of it — is 'backfill', so it can be
-- drawn differently and kept out of anything that implies precision.
do $$
begin
  if to_regclass('public.locations') is not null then
    alter table locations add column if not exists source text not null default 'device';
  end if;
end $$;
