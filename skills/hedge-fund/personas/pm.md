# Portfolio Manager — deterministic aggregation reference

> **Pattern adapted from [virattt/ai-hedge-fund]**
> (https://github.com/virattt/ai-hedge-fund) (educational use).
> Upstream's PM is a tiny LLM call that picks one allowed action per
> ticker from validated inputs. Our demo replaces the LLM call with
> deterministic confidence-weighted aggregation in
> `scripts/aggregate.mjs`, because we need explicit weights for a
> Sherwood PortfolioStrategy proposal — not buy/sell actions per
> ticker.

The Portfolio Manager step is **not** an LLM call. It runs in
`scripts/aggregate.mjs` after each persona has emitted its signals.
This file documents the math so the LLM (when narrating to chat) and
humans can audit it.

## Inputs

- N persona signal files (`signals/<name>.json`), each containing per-token
  `{signal, confidence, reasoning}` triples. Schema documented in each
  `personas/<name>.md`.
- `tokens.json` (basket definition with `tail` flag for risk caps).
- Risk caps (CLI flags to `aggregate.mjs`): `--max-single`,
  `--max-longtail`, `--usdc-floor`.

## Algorithm

1. **Signal → weight (per persona, per token).** Convert each
   `{signal, confidence}` into a non-negative score:
   - `bullish`  → `+confidence/100`
   - `neutral`  → `0`
   - `bearish`  → `−confidence/100`, clipped to 0 (we run long-only)
   USDC is special-cased: `bearish` USDC is interpreted as the persona
   wanting maximum risk-on (USDC → 0% weight), but we never let USDC
   fall below the `--usdc-floor`. See Step 4 below.
3. **Per-persona normalization.** Per persona, normalize the five
   non-negative scores so they sum to 1.0. If a persona's scores are
   all zero (all bearish/neutral), assign 100% to USDC (defensive).
4. **Cross-persona aggregation.** For each token, take the average of
   the per-persona normalized weights. (Equal weighting across
   personas — Buffett / Wood / Burry get equal say.) Renormalize to
   sum to 1.0.
5. **Apply Risk Manager caps** (see `personas/risk-manager.md`).
6. **Final renormalization** to sum to exactly 1.0.

## Output

A `target-weights.json` file with this shape:

```json
{
  "weights": {"USDC": 0.18, "cbBTC": 0.42, "WETH": 0.30, "AERO": 0.07, "DEGEN": 0.03},
  "adjustments": [
    "AERO clipped 0.14 → 0.07 (long-tail cap)",
    "USDC raised 0.05 → 0.10 (USDC floor)"
  ],
  "by_persona_normalized": {
    "warren-buffett": {"USDC": 0.45, ...},
    "cathie-wood":    {"USDC": 0.05, ...},
    "michael-burry":  {"USDC": 0.50, ...}
  },
  "by_persona_raw_scores": { ... }
}
```

## Why deterministic, not LLM

- **Reproducibility**: an aggregator that outputs the same target weights
  for the same persona inputs makes the demo's "what would have changed"
  comparisons honest.
- **Auditability**: observers can rerun `aggregate.mjs` against the
  posted persona JSONs and confirm the math.
- **Scope**: an LLM PM was a fit for upstream where it picks actions and
  validates against per-ticker max-quantity envelopes. Our PM only needs
  to produce normalized weights for a Sherwood proposal — the math fits
  in 60 lines.
