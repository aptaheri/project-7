-- Clears every location fix recorded during setup and testing.
--
-- Those were logged with locatorDisplacement at 0, so a stationary phone kept
-- reporting and GPS drift accumulated distance that was never ridden. Starting
-- empty means the distance and elevation-gain figures describe the expedition
-- rather than a bike parked in a garage.
--
-- Only the fixes go. Account roles in `viewers` are untouched.
do $$
begin
  if to_regclass('public.locations') is not null then
    delete from locations;
  end if;
end $$;
