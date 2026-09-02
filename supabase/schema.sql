-- Ken Finance — Supabase schema
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New
-- query), then set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
-- in frontend/.env.
--
-- Two things here are load-bearing and should not be relaxed:
--
--   1. amount_minor is BIGINT. Money is an integer number of paise
--      everywhere in this project (rules.md §1). A NUMERIC or DOUBLE column
--      would let a float in through some other client and corrupt totals
--      irrecoverably.
--   2. Row Level Security is enabled on every table with no permissive
--      fallback. Supabase's anon key ships inside the app and is readable by
--      anyone who installs it, so RLS is the only thing standing between one
--      user's transactions and another's. A table without a policy is not
--      "open by default" here — it is unreadable, which is the safe failure.

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------

create table if not exists public.transactions (
  -- Ids are generated on the device and never reassigned, so they survive the
  -- round trip and can be matched on either side.
  id                text        primary key,
  user_id           uuid        not null references auth.users (id) on delete cascade,

  amount_minor      bigint      not null,
  title             text        not null,
  category          text        not null,
  paid_to           text        not null,
  account_info      text        not null,
  transaction_type  text        not null check (transaction_type in ('Debit', 'Credit')),
  occurred_at       timestamptz not null,

  source            text        not null,
  channel           text        not null,
  ref_no            text,
  account_tail      text,

  -- Same guarantee as the local database: one real payment cannot become two
  -- rows, enforced per user rather than globally.
  dedupe_key        text        not null,

  raw_payload       text,
  status            text        not null,
  skipped_count     integer     not null default 0,
  last_prompted_at  timestamptz,

  note              text,
  transcript        text,
  audio_path        text,

  -- Sync metadata. deleted_at is a tombstone: a hard delete cannot propagate,
  -- because a row that simply vanishes is indistinguishable from one this
  -- device has not seen yet, and would be pushed straight back.
  updated_at        timestamptz not null,
  deleted_at        timestamptz,

  created_at        timestamptz not null default now(),

  constraint transactions_dedupe_unique unique (user_id, dedupe_key)
);

create index if not exists transactions_user_updated_idx
  on public.transactions (user_id, updated_at desc);

create index if not exists transactions_user_occurred_idx
  on public.transactions (user_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- merchants — what the user taught the app about who they pay
-- ---------------------------------------------------------------------------

create table if not exists public.merchants (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  -- Normalised key from frontend/src/merchants/normalize.ts, never the raw
  -- name: the same shop arrives spelled differently per channel.
  key          text        not null,
  display_name text        not null,
  category     text        not null,
  seen_count   integer     not null default 1,
  updated_at   timestamptz not null,

  primary key (user_id, key)
);

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------

create table if not exists public.budgets (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  category     text        not null,
  amount_minor bigint      not null,
  updated_at   timestamptz not null,

  primary key (user_id, category)
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Every policy is scoped to auth.uid(). with check on insert and update is
-- what stops a client writing a row attributed to somebody else — a using
-- clause alone would prevent reading another user's rows while still allowing
-- them to be created.

alter table public.transactions enable row level security;
alter table public.merchants    enable row level security;
alter table public.budgets      enable row level security;

drop policy if exists "own transactions" on public.transactions;
create policy "own transactions" on public.transactions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own merchants" on public.merchants;
create policy "own merchants" on public.merchants
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own budgets" on public.budgets;
create policy "own budgets" on public.budgets
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Guard against a float ever reaching a money column
-- ---------------------------------------------------------------------------
-- BIGINT already rejects a fractional literal, but an explicit check makes the
-- intent legible to anyone reading the schema later and unable to see
-- rules.md.

alter table public.transactions
  drop constraint if exists transactions_amount_is_paise;
alter table public.transactions
  add constraint transactions_amount_is_paise check (amount_minor = trunc(amount_minor));

alter table public.budgets
  drop constraint if exists budgets_amount_is_paise;
alter table public.budgets
  add constraint budgets_amount_is_paise check (amount_minor = trunc(amount_minor) and amount_minor > 0);
