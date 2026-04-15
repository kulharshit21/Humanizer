# Tone Calibration Workflow

This project now supports per-tone quantitative calibration for decoding deltas (`temperature`, `top_p`) using gold examples and grid search.

## Files

- `calibration/gold-examples.jsonl`: gold tone examples (`input` + `reference`)
- `src/lib/tone-profiles.json`: tone instructions, style rules, blocked patterns, default deltas
- `src/lib/tone-calibration.json`: active calibrated deltas consumed by API route
- `scripts/calibrate-tone-presets.mjs`: calibration runner

## Gold Data Guidance

For production-quality calibration, use **30-50 examples per tone** with high-quality references.

Per JSONL line:

```json
{
  "id": "academic-042",
  "tone": "academic",
  "input": "source text",
  "reference": "target rewrite"
}
```

## Run Calibration

Set env vars and run:

```bash
MISTRAL_API_KEY=... MISTRAL_MODEL=mistral-large-latest node scripts/calibrate-tone-presets.mjs
```

Recommended sequence:

```bash
npm run calibrate:scaffold
# Fill calibration/gold-examples.jsonl with real data
npm run calibrate:validate
npm run calibrate:tones
```

Optional:

- `CALIBRATION_STRENGTH=balanced` (or `minimal/strong/maximum`)
- `MAX_EXAMPLES_PER_TONE=12` for cost control during iteration

## What the script does

1. Loads tone profiles + gold examples
2. Runs grid search over delta candidates for each tone
3. Scores candidates automatically by:
   - meaning preservation
   - reference similarity
   - citation retention
   - lexical diversity
   - repetition penalty
4. Writes best deltas to `src/lib/tone-calibration.json`
5. Writes a run report in `calibration/reports/`

## API usage

`src/app/api/humanize/route.ts` automatically uses calibrated deltas from `src/lib/tone-calibration.json`.
