# Human rating rubric — AI module summaries (Phase 8F)

The eval harness gates *objective* signals automatically (clustering purity/ARI,
summary structural validity, determinism, goldens). Whether a summary is
**good** is a human judgement and is never fabricated by the harness
(ROADMAP §9c, ADR-0031). This rubric is how a human turns real model summaries
into a score the harness can trend and floor-gate.

## What you rate

Real summaries recorded from a live provider —
`evals/out/module-summaries.<provider>.<model>.json`, produced by:

```sh
<PROVIDER>_API_KEY=… node evals/run.mjs --record <provider> <model> \
  --task summarize --consent-live
```

Do **not** rate the mock outputs in `evals/goldens/` or temporary outputs from
`pnpm test:evals`; they are deterministic plumbing stand-ins, not model quality.

For each of the 20 modules, open the real code the members name (the `label`
fields in `evals/fixtures/module-summaries.json` mirror exported symbols) and
judge the recorded name + summary against it.

## Scale (1–5, integer)

| Score | Meaning |
|---|---|
| 5 | Faithful and sharp. Name is what a maintainer would call the module; summary states its real responsibility, grounded only in the members. |
| 4 | Faithful, slightly generic or wordy. No errors. |
| 3 | Roughly right but vague, or leans on one member and misses the whole. |
| 2 | Partly wrong: over-claims, mislabels the dominant concern, or drifts from the members. |
| 1 | Wrong or hallucinated: asserts facts not supported by the members. |

Anchor with the human-authored `reference` in the fixture — that is *a* faithful
answer (name + one sentence), not *the* required wording. A 5 need not match it;
it needs to be as faithful.

## Flags (record alongside the score)

- `hallucination` — asserts a fact no member supports (always caps the score at 1).
- `filler` — "various/miscellaneous/things"; a structural check already catches the worst of these.
- `mislabel` — dominant kind/concern named wrong.

## Recording your ratings

Write `evals/ratings/module-summaries.ratings.json` in the shape of
`module-summaries.ratings.example.json`. When that file exists, the harness
enforces `summary-human-mean-min` (evals/floors.json). File any summary that
scores ≤ 2 as a prompt issue against `SUMMARIZE_ROLLUP_PROMPT` (bump its
`version` when the prompt text changes — that re-keys the replay cache).
