# Authenticity Signals: Design Notes

## What was added

- `POST /api/detect` endpoint with input validation and authenticated access.
- Server-side detector orchestrator with:
  - local heuristic detectors (`binoculars`, `detectgpt`-style proxy, `gltr`-style patterns)
  - vendor adapters (`gptzero`, `originalityai`, `copyleaks`, `sapling`) behind feature flags + explicit consent
  - parallel execution, retries, per-detector timeouts, normalized output schema
  - ensemble summary (`riskBand`, `disagreement`, `calibratorVersion`)
- Privacy modes:
  - `no_log` (no persistence)
  - `hash_only` (hash + metrics only)
  - `full_text_opt_in` (explicit text storage)
- Abuse safeguards:
  - per-user/IP rate limiting
  - repeated near-identical rescans reduce details
- Frontend authenticity panel:
  - disclaimer-first UX
  - detector cards, disagreement warning, explainability signals
  - optional sentence highlights (guarded)
  - report export stub + policy/integrity modal in academic mode

## Intentional guardrails (not added)

- No detector-evasion coaching or rewrite advice to "beat" detectors.
- No "target score" UX or thresholds for passing/failing.
- No direct wording that a detection result is definitive proof.

## Limitations

- Vendor APIs may evolve and occasionally require endpoint/payload updates.
- Originality.ai response fields can vary by account/version; use `ORIGINALITYAI_ENDPOINT` if your tenant route differs.
- Local detectors are heuristic signals, not forensic authorship proofs.
- In-memory rate-limit state resets on server restart.

