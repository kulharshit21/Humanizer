-- 002_rewrites_quality_score.sql
-- Adds persisted quality scoring for humanized outputs.

alter table public.rewrites
add column if not exists quality_score integer
check (quality_score is null or (quality_score >= 0 and quality_score <= 100));
