-- ============================================================
-- HUEBLOC Trading — Supabase Schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New Query)
-- ============================================================

-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- MEMBERS
-- One row per paying (or attempted-paying) customer.
-- This is the source of truth for "does this email have access?"
-- ------------------------------------------------------------
create table if not exists members (
  id                       uuid primary key default gen_random_uuid(),
  email                    text not null unique,
  stripe_customer_id       text unique,
  stripe_payment_intent_id text unique,

  -- One-time $50 payment, so there's no subscription lifecycle to track —
  -- just: haven't paid yet, paid, or refunded.
  -- One of: incomplete | active | refunded
  payment_status           text not null default 'incomplete',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_members_email on members (lower(email));
create index if not exists idx_members_stripe_customer on members (stripe_customer_id);

-- Keep updated_at current on every change
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_members_updated_at on members;
create trigger trg_members_updated_at
  before update on members
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- MAGIC LINKS
-- Short-lived, single-use login tokens.
-- We store a HASH of the token, never the raw token — the raw
-- token only ever exists in the emailed URL and briefly in
-- function memory. This mirrors how you'd handle password-reset
-- tokens: if the table ever leaked, no one could log in as a member.
-- ------------------------------------------------------------
create table if not exists magic_links (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists idx_magic_links_token_hash on magic_links (token_hash);
create index if not exists idx_magic_links_email on magic_links (lower(email));

-- Optional housekeeping: delete expired/used tokens older than 30 days.
-- Supabase → Database → Cron Jobs can run this on a schedule (pg_cron).
-- select cron.schedule('cleanup_magic_links', '0 3 * * *', $$
--   delete from magic_links where expires_at < now() - interval '30 days';
-- $$);

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Both tables are only ever touched by Netlify Functions using the
-- SUPABASE_SERVICE_ROLE_KEY (server-side secret, bypasses RLS).
-- The browser never talks to Supabase directly, so RLS just needs
-- to stay ON with no public policies — this blocks any accidental
-- client-side/anon-key access entirely.
-- ------------------------------------------------------------
alter table members enable row level security;
alter table magic_links enable row level security;
-- No policies added on purpose: anon/authenticated roles get zero access.
-- Only the service_role key (used server-side only) can read/write.
