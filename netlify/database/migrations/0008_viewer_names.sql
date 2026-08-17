-- Who each address actually is.
--
-- An email alone is a poor way to recognise someone: half of them are
-- first.last@work.com and the other half are a nickname and four digits. The
-- names arrive from the Google ID token at sign-in, which already carries
-- given_name and family_name, so nobody is asked to type what Google can say
-- for them.
--
-- Nullable and separate from the address on purpose. An invited viewer has a
-- row before they have ever signed in, and so no name yet; an owner can fill it
-- in from the sharing page, and a later sign-in must never overwrite what they
-- typed.
do $$
begin
  if to_regclass('public.viewers') is not null then
    alter table viewers add column if not exists first_name text;
    alter table viewers add column if not exists last_name text;
  end if;
end $$;
