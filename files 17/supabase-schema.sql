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
  -- just: haven't paid yet, paid, refunded, or disputed (chargeback).
  -- One of: incomplete | active | refunded | disputed
  payment_status           text not null default 'incomplete',

  -- Set once the member connects their Discord account. Nullable — not
  -- everyone connects immediately after paying.
  discord_user_id          text,
  discord_username         text,

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

-- ============================================================
-- CURRICULUM — The HUEBLOC Playbook
-- Structure: Phases (7 total) → Lessons (several per phase).
-- Craig sends content one phase at a time; each phase gets inserted
-- here via a SQL script (see curriculum-inserts/ for each phase's file)
-- rather than needing a full admin UI — Claude writes the INSERT,
-- Craig just runs it in the Supabase SQL Editor.
-- ------------------------------------------------------------

create table if not exists phases (
  id            uuid primary key default gen_random_uuid(),
  phase_number  integer not null unique,
  title         text not null,
  objective     text,
  created_at    timestamptz not null default now()
);

create table if not exists lessons (
  id             uuid primary key default gen_random_uuid(),
  phase_id       uuid not null references phases(id) on delete cascade,
  lesson_number  integer not null,
  title          text not null,
  briefing       text,   -- opening quote/framing, if this phase uses one (nullable)
  content        text not null,  -- main lesson body. Supports simple inline
                                  -- images via ![](image-url.jpg) on their own line.
  principle      text,   -- the closing takeaway/quote
  principle_label text not null default 'Key Takeaway',  -- e.g. 'Commander''s Principle' for Phase I, 'Key Takeaway' for Phase II
  created_at     timestamptz not null default now(),
  unique (phase_id, lesson_number)
);

create table if not exists phase_videos (
  id           uuid primary key default gen_random_uuid(),
  phase_id     uuid not null references phases(id) on delete cascade,
  part_number  integer not null default 1,
  title        text,
  youtube_id   text not null,
  created_at   timestamptz not null default now(),
  unique (phase_id, part_number)
);

-- Tracks which lessons a member has personally marked complete.
create table if not exists lesson_progress (
  id             uuid primary key default gen_random_uuid(),
  member_email   text not null,
  lesson_id      uuid not null references lessons(id) on delete cascade,
  completed_at   timestamptz not null default now(),
  unique (member_email, lesson_id)
);

create index if not exists idx_lessons_phase on lessons (phase_id);
create index if not exists idx_phase_videos_phase on phase_videos (phase_id);
create index if not exists idx_lesson_progress_email on lesson_progress (lower(member_email));

-- Migration for existing deployments: if you already ran this file once
-- (for Phase I), the line below adds the new column to your existing
-- lessons table. Safe to run even on a brand-new database — it's a no-op
-- if the column already exists.
alter table lessons add column if not exists principle_label text not null default 'Key Takeaway';
-- Phase I already used "Commander's Principle" specifically, so backfill
-- that phase's existing rows to keep their original wording:
update lessons set principle_label = 'Commander''s Principle'
where phase_id = (select id from phases where phase_number = 1);

-- Migration: adds Discord connection columns to an existing members table.
alter table members add column if not exists discord_user_id text;
alter table members add column if not exists discord_username text;

alter table phases enable row level security;
alter table lessons enable row level security;
alter table phase_videos enable row level security;
alter table lesson_progress enable row level security;
-- Same rule as above: no public policies. Curriculum content is only
-- readable through the get-curriculum function, which checks the
-- member's session and active status before returning anything —
-- this is what keeps the Playbook from being a free-for-all.
