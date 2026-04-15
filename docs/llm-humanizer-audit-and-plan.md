# LLM Humanizer Audit and Redesign Plan

## 1) Current System Audit

### Current training approach
- No fine-tuning or training code is present in this repository.
- Current system is inference-only, implemented in `src/app/api/humanize/route.ts`.

### Current dataset format
- No dataset artifacts (`.jsonl`, loaders, training configs) are present in this app repository.
- Existing stored data (`rewrites`) is runtime history, not curated training data.

### Current prompt style
- Strong system prompt with explicit anti-AI writing constraints (`src/lib/constants.ts`).
- User prompt includes tone and rewrite-strength controls.
- Retry prompt injects failed quality checks.

### Current inference style
- One-pass generation with up to 3 retries based on quality checks.
- Validation includes overlap, repetition, banned phrases, em-dash frequency, and sentence-start repetition.

### Current decoding parameters
- Previously fixed temperature; now upgraded to strength-aware presets:
  - minimal: lower creativity, conservative edits
  - balanced: moderate edits
  - strong/maximum: higher variation

### Weaknesses still causing AI-like output risk
- No domain-specific fine-tuned checkpoints.
- No preference optimization (DPO/ORPO) yet.
- No benchmark harness with pairwise judgments and drift scoring.
- Prompt-only control can plateau on hard inputs.

### Risks
- Leakage risk: low in this repo, but training pipeline should split by source and time to avoid contamination.
- Overfitting risk: high if future fine-tuning uses templated synthetic targets.
- Repetition/style-collapse risk: medium without diverse preference data and style balancing.

## 2) Recommended Fine-Tuning Strategy

### Multi-stage training plan
1. **SFT stage**: high-quality rewrite pairs with explicit metadata controls (tone/domain/intensity).
2. **Preference stage**: DPO on ranked candidates for naturalness + faithfulness.
3. **Safety/faithfulness stage**: contrastive negatives for meaning drift and unsupported additions.

### Why DPO (recommended first)
- Lower operational complexity than full RLHF.
- Works well for ranking "better rewrite" vs "worse rewrite" pairs.
- Directly aligns style naturalness without changing product architecture.

## 3) Dataset Redesign

See `docs/llm-humanizer-dataset-schema.json` for implementation schema.

Key requirements:
- Include style tags, tone/domain labels, rewrite intensity, and quality scores.
- Add hard negatives:
  - robotic phrasing
  - meaning drift
  - unsupported claims
  - synonym-only rewrites
  - over-polished unnatural outputs

## 4) Inference Redesign (implemented in this repo)

- Added decoding presets keyed by rewrite strength.
- Added post-generation sanitizer for repeated lines and excessive em-dashes.
- Kept retry loop with quality checks and issue-informed regeneration.

## 5) Evaluation Framework

See `docs/llm-humanizer-eval-rubric.md` for:
- benchmark categories
- metric definitions
- LLM-judge and human pairwise rubric
- failure taxonomy

## 6) Next Experiment Priority

1. Build dataset curation + dedup pipeline.
2. Create 2-3k high-signal preference pairs and run DPO.
3. Run benchmark suite across essays/emails/blog/social/academic.
4. Tune decoding presets per domain using offline eval.
5. Add online A/B quality monitoring from production traffic (opt-in sampled).
