-- Removes the rows inserted while verifying the ingest endpoint against
-- production. Guarded because the table is created lazily on cold start, so it
-- may not exist yet in a fresh branch database.
do $$
begin
  if to_regclass('public.locations') is not null then
    delete from locations where device = 'owntracks/selftest/curl';
  end if;
end $$;
