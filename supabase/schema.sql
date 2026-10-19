create extension if not exists pgcrypto;
create table if not exists partners (id text primary key, name text not null, share numeric not null default 0, minimum numeric not null default 0, discount numeric not null default 0, password_hash text not null, role text not null default 'partner');
create table if not exists banks (id uuid primary key default gen_random_uuid(), name text not null);
create table if not exists closings (id uuid primary key default gen_random_uuid(), quarter text not null, current_cash numeric not null, previous_distribution numeric not null, distribution_pct numeric not null, rows jsonb not null, created_at timestamptz not null default now());
alter table partners enable row level security; alter table banks enable row level security; alter table closings enable row level security;
-- API calls use the Supabase service role from Vercel; no database key is shipped to the browser.
