# LLM Humanizer Evaluation Rubric

## Benchmark Buckets
- Essays
- Student writing
- Emails
- Blogs
- Social posts
- Academic text
- Business writing
- AI-generated drafts
- Mixed noisy drafts

## Scoring Dimensions (1-5)
1. Meaning preservation
2. Naturalness
3. Fluency
4. Discourse coherence
5. Lexical diversity
6. Sentence rhythm variation
7. Domain appropriateness
8. Over-editing control
9. Hallucination safety
10. Robotic-pattern reduction

## Pairwise Judge Prompt (LLM-as-judge)
- Compare Candidate A vs Candidate B against source text.
- Choose better rewrite by:
  - preserving meaning
  - reducing robotic style
  - improving flow
  - avoiding unsupported additions
- Return JSON:
  - winner: "A" | "B" | "tie"
  - confidence: 0-1
  - reasons: short bullet list

## Failure Taxonomy
- Unchanged robotic output
- Over-humanized odd phrasing
- Semantic drift
- Unsupported detail insertion
- Over-short/over-long rewrite
- Repetitive sentence openings
- Same cadence across paragraph
- Domain style mismatch

## Red-Team Set
- Fact-dense technical paragraphs
- Inputs with dates, figures, legal constraints
- Already-good human text (should avoid over-editing)
- Ambiguous social posts (should avoid hallucinated context)

## Release Gate (recommended)
- Minimum mean score:
  - Meaning preservation >= 4.6
  - Naturalness >= 4.2
  - Hallucination safety >= 4.8
- Pairwise win rate against previous checkpoint >= 58%
- No benchmark bucket below threshold for two consecutive runs
