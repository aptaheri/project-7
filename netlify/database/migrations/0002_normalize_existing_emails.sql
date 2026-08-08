-- Folds gmail addresses stored before normalisation existed into their
-- canonical form, so a row granted as `first.last@gmail.com` still matches the
-- `firstlast@gmail.com` that Google's ID token normalises to. Without this, an
-- already-granted person is treated as a brand new pending user.
--
-- Where both spellings exist, the stronger role wins so the merge can never
-- quietly downgrade somebody.
do $$
declare
  r record;
begin
  if to_regclass('public.viewers') is null then
    return;
  end if;

  for r in
    select
      email,
      replace(split_part(split_part(email, '@', 1), '+', 1), '.', '') || '@gmail.com' as canonical,
      role
    from viewers
    where split_part(email, '@', 2) in ('gmail.com', 'googlemail.com')
  loop
    if r.canonical <> r.email then
      insert into viewers (email, role, granted_by)
      values (r.canonical, r.role, 'normalize')
      on conflict (email) do update
        set role = case
              when viewers.role = 'owner' or excluded.role = 'owner' then 'owner'
              when viewers.role = 'viewer' or excluded.role = 'viewer' then 'viewer'
              else viewers.role
            end,
            updated_at = now();

      delete from viewers where email = r.email;
    end if;
  end loop;
end $$;
