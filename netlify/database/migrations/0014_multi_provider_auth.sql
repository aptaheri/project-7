-- Sign-in for people who have neither a Google nor a Microsoft account, and a
-- way to grant access to an identity rather than to a string.
--
-- Mirrors ensureSchema in netlify/lib/db.mts, which is what actually runs on
-- deploy. This file is the record.

-- An email address is not proof of anything. Microsoft lets any tenant set a
-- user's email attribute to whatever it likes and issues no email_verified
-- claim, so a token bearing a viewer's address is a claim and nothing more.
-- Access is therefore granted to a subject — Google's sub, Microsoft's
-- oid+tid, or an address a magic link was delivered to and clicked from — and
-- the email beside it is what an owner reads when deciding, nothing more.
create table if not exists auth_identities (
  provider   text not null,
  subject    text not null,
  email      text not null,
  first_name text,
  last_name  text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (provider, subject)
);

create index if not exists auth_identities_email_idx on auth_identities (email);

-- One-time sign-in links. The token is stored hashed and never in the clear: a
-- leaked table of live tokens is a leaked set of sessions, a leaked table of
-- hashes is not, and the original is never needed again — a link is checked by
-- hashing what arrives and looking for the result.
create table if not exists magic_link_tokens (
  token_hash text primary key,
  email      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create index if not exists magic_link_tokens_expires_idx
  on magic_link_tokens (expires_at);

-- Which way in worked last time, so a returning viewer is offered that one
-- first instead of being asked again.
alter table viewers add column if not exists last_provider text;
