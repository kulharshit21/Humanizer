# Humanizer Studio

Full-stack humanization app built with Next.js, Supabase auth, and Mistral API.

## Features

- Supabase email/password authentication (sign up, sign in, sign out)
- Protected humanization API route
- Authenticity-signals detection route with privacy modes
- Skill-driven rewriting prompt (human-like style cleanup)
- 1000-word input limit per generation
- Clean two-panel writing UI with copy support

## Tech Stack

- Next.js (App Router, TypeScript)
- Supabase (`@supabase/supabase-js`)
- Mistral Chat Completions API
- Tailwind CSS

## Setup

1) Install dependencies:

```bash
npm install
```

2) Create env file:

```bash
cp .env.example .env.local
```

3) Fill `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=... # or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
MISTRAL_API_KEY=...
MISTRAL_MODEL=mistral-large-latest
DETECTOR_ENABLE_GPTZERO=false
DETECTOR_ENABLE_ORIGINALITYAI=false
DETECTOR_ENABLE_COPYLEAKS=false
DETECTOR_ENABLE_SAPLING=false
DETECTOR_ENABLE_DETECTGPT=false
GPTZERO_API_KEY=
ORIGINALITYAI_API_KEY=
COPYLEAKS_API_KEY=
COPYLEAKS_EMAIL=
SAPLING_API_KEY=
GPTZERO_ENDPOINT=https://api.gptzero.me/v2/predict/text
GPTZERO_MODEL_VERSION=2024-11-20
ORIGINALITYAI_ENDPOINT=https://api.originality.ai/api/v3/scan/ai
COPYLEAKS_AUTH_ENDPOINT=https://id.copyleaks.com/v3/account/login/api
COPYLEAKS_DETECT_ENDPOINT=
COPYLEAKS_SENSITIVITY=2
COPYLEAKS_SANDBOX=false
SAPLING_ENDPOINT=https://api.sapling.ai/api/v1/aidetect
```

4) Run dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supabase Notes

- Enable Email auth in your Supabase project.
- If email confirmation is enabled, users must verify their email before first sign-in.
- Run SQL migration before using profile/history storage:
  - `supabase/migrations/001_user_profiles_and_rewrites.sql`
- `supabase/migrations/002_rewrites_quality_score.sql`
- `supabase/migrations/003_detection_scans.sql`

## API Route

- `POST /api/humanize`
- Requires `Authorization: Bearer <supabase_access_token>`
- Body:

```json
{
  "text": "text to humanize",
  "tone": "professional",
  "strength": "balanced"
}
```

If input exceeds 1000 words, request is rejected.

### Authenticity Signals API

- `POST /api/detect`
- Requires `Authorization: Bearer <supabase_access_token>`
- Body:

```json
{
  "text": "text to analyze",
  "context": { "language": "en", "mode": "academic" },
  "privacy_mode": "hash_only",
  "vendor_consent": false,
  "details_enabled": true
}
```

### Important Safety Notes

- Detection output is probabilistic guidance, not proof.
- The app does not provide detector-evasion coaching or target-score UX.
- Repeated near-identical rescans get reduced detail.
- Vendor detectors are behind feature flags and explicit consent.

## Stored Data (Real Data Only)

After running migration SQL, app stores:

- `profiles`: user details (name, role, company, website, bio)
- `rewrites`: input/output history for each user
- `detection_scans`: text hash + scores + detector telemetry (raw text only if explicit opt-in)

Tables are protected by RLS and only accessible by the owning user.
