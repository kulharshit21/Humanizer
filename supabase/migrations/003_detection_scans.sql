-- 003_detection_scans.sql
-- Privacy-conscious authenticity-signal scan logging.

create table if not exists public.detection_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  text_hash text not null,
  text_length integer not null check (text_length > 0),
  privacy_mode text not null check (privacy_mode in ('no_log', 'hash_only', 'full_text_opt_in')),
  risk_band text not null check (risk_band in ('low', 'medium', 'high', 'inconclusive')),
  ensemble_score numeric(6, 2) not null,
  disagreement_score numeric(6, 2) not null,
  calibrator_version text not null,
  detectors_summary jsonb not null default '[]'::jsonb,
  explainability_signals jsonb not null default '{}'::jsonb,
  raw_text text null,
  created_at timestamptz not null default now()
);

create index if not exists detection_scans_user_created_idx
  on public.detection_scans (user_id, created_at desc);

create index if not exists detection_scans_hash_idx
  on public.detection_scans (user_id, text_hash);

alter table public.detection_scans enable row level security;

drop policy if exists "detection_scans_select_own" on public.detection_scans;
create policy "detection_scans_select_own"
on public.detection_scans
for select
using (auth.uid() = user_id);

drop policy if exists "detection_scans_insert_own" on public.detection_scans;
create policy "detection_scans_insert_own"
on public.detection_scans
for insert
with check (auth.uid() = user_id);

