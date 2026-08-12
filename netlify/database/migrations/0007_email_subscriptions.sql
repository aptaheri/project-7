-- Who gets the daily email, and what has already been sent.
--
-- The viewers table is already the list: everyone who can see the tracker is
-- someone an owner approved, so there is no separate subscriber list to keep in
-- step. A text preference rather than a boolean leaves room for 'weekly' or
-- 'milestones' without another migration once people start unsubscribing.
do $$
begin
  if to_regclass('public.viewers') is not null then
    alter table viewers add column if not exists email_pref text not null default 'daily';
  end if;
end $$;

-- One row per email actually sent, so a retry, an overlapping scheduled run, or
-- a redeploy mid-send cannot mail everyone twice. The date is the rider's local
-- day, matching how days are counted everywhere else.
create table if not exists sent_emails (
  local_date  date not null,
  kind        text not null default 'daily',
  sent_at     timestamptz not null default now(),
  recipients  int not null default 0,
  subject     text,
  primary key (local_date, kind)
);
