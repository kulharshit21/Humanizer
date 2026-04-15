# Gold Data Collection Playbook

Use this playbook before running `npm run calibrate:tones`.

## Goal

Create a high-quality gold dataset for tone calibration:
- 30-50 examples **per tone**
- 9 tones total (`casual`, `professional`, `creative`, `academic`, `linkedin`, `blog`, `email`, `simplify`, `human-like`)
- Recommended total: **270-450+ examples**

## Commands

Scaffold placeholders:

```bash
npm run calibrate:scaffold
```

Validate dataset quality and coverage:

```bash
npm run calibrate:validate
```

Run calibration only after validation passes:

```bash
npm run calibrate:tones
```

## Data format (`calibration/gold-examples.jsonl`)

One JSON object per line:

```json
{
  "id": "academic-001",
  "tone": "academic",
  "input": "source text",
  "reference": "high-quality human rewrite"
}
```

## Quality rules for references

- Preserve factual meaning and key claims
- Keep citations and references intact where present
- Avoid robotic transitions and repetitive cadence
- Avoid marketing hype unless tone requires it
- Do not add unsupported details
- Keep grammar correct and natural

## Suggested data sources

- Your own approved rewrites (best)
- Team-written rewrites from real domain drafts
- Public, permissive text corpora with proper attribution if required

## What NOT to do

- Do not use placeholders (`TODO_*`) in final dataset
- Do not include near-duplicate inputs
- Do not include references that change core meaning
- Do not calibrate with fewer than 30 per tone

## Validation gate

`npm run calibrate:validate` enforces:
- valid JSONL
- required fields
- no TODO placeholders
- minimum per-tone coverage
- duplicate id/input checks
- minimum input/reference length
