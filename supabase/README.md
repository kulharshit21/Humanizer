# Supabase Setup

This folder contains SQL migrations for real user data.

## Run migration

Open Supabase dashboard -> SQL Editor, then run:

- `supabase/migrations/001_user_profiles_and_rewrites.sql`

## What it creates

- `public.profiles`: user details (display name, full name, role, company, website, bio)
- `public.rewrites`: rewrite history per user
- RLS policies so each user can only access their own rows
- Trigger to auto-create a `profiles` row when a new auth user signs up

No seeded/demo data is included.
