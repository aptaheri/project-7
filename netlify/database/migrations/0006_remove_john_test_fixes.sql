-- Removes the fixes John's phone sent on 8 August 2026.
--
-- Those were produced while setting the tracker up — clearing the encryption
-- key, tapping Send Debug Status, walking a hallway — not riding. Leaving them
-- would put a 0.1 mile "day" in the history and a marker on the map for a day
-- he did not ride.
--
-- The date is bucketed in Portuguese local time, matching how days are counted
-- everywhere else.
do $$
begin
  if to_regclass('public.locations') is not null then
    delete from locations
    where source = 'device'
      and device like 'owntracks/john/%'
      and (tst at time zone 'Europe/Lisbon')::date = date '2026-08-08';
  end if;
end $$;
