-- 001_user_profiles_and_rewrites.sql
-- Core schema for user account details and rewrite history.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  full_name text,
  role_title text,
  company text,
  website text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rewrites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  input_text text not null,
  input_word_count integer not null check (input_word_count >= 1 and input_word_count <= 1000),
  output_text text not null,
  output_word_count integer not null check (output_word_count >= 1),
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists rewrites_user_created_idx
  on public.rewrites (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.rewrites enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles
for select
using (auth.uid() = user_id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles
for insert
with check (auth.uid() = user_id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "rewrites_select_own" on public.rewrites;
create policy "rewrites_select_own"
on public.rewrites
for select
using (auth.uid() = user_id);

drop policy if exists "rewrites_insert_own" on public.rewrites;
create policy "rewrites_insert_own"
on public.rewrites
for insert
with check (auth.uid() = user_id);

drop policy if exists "rewrites_delete_own" on public.rewrites;
create policy "rewrites_delete_own"
on public.rewrites
for delete
using (auth.uid() = user_id);
