# Changelog

All notable changes to this project are documented in this file.

## [2026-04-15] - Authenticity Signals + Calibration Reliability

### Added
- New server route: `POST /api/detect` for authenticity signal analysis.
- Detector orchestrator with normalized output schema and ensemble summary fields:
  - `riskBand`
  - `disagreement`
  - `calibratorVersion`
- Local detector modules:
  - Binoculars-style heuristic detector
  - DetectGPT-style gated proxy
  - GLTR-style explainability extraction
- Vendor detector integrations (feature-flag + consent gated):
  - GPTZero
  - Originality.ai
  - Copyleaks
  - Sapling
- Privacy-aware detection logging migration:
  - `supabase/migrations/003_detection_scans.sql`
- Detection evaluation CLI:
  - `detect:eval`
  - `scripts/detect-eval.mjs`
- Detection fixtures:
  - `calibration/detection-fixtures.jsonl`
- Detection test suite:
  - orchestrator unit tests
  - schema tests
  - API route safeguard tests

### Changed
- Frontend `Authenticity signals` panel in `src/app/page.tsx`:
  - detector cards and summary band
  - disagreement warning
  - explainability signal bars
  - optional details mode with safeguards
  - report export JSON
  - policy/integrity modal in academic mode
- Calibration script resilience in `scripts/calibrate-tone-presets.mjs`:
  - adaptive throttling under 429 pressure
  - expanded retry handling
  - exponential backoff + jitter
  - checkpoint/resume support for long runs
- Environment documentation for detector endpoints/keys/flags:
  - `.env.example`
  - `README.md`

### Security and Privacy Guardrails
- No detector-evasion coaching or bypass guidance.
- No target-score UX.
- Detector output is framed as probabilistic, not proof.
- Raw text persistence is opt-in only via `privacy_mode=full_text_opt_in`.

### Database
- Added `detection_scans` table with RLS policies.
- Existing migrations retained:
  - `001_user_profiles_and_rewrites.sql`
  - `002_rewrites_quality_score.sql`

### Verification
- `npm run lint`
- `npm run test:detect`
- `npm run build`

