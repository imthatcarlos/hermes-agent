# Risk Manager — deterministic caps reference

> **Pattern adapted from [virattt/ai-hedge-fund]**
> (https://github.com/virattt/ai-hedge-fund) (educational use).
> Upstream's risk_management_agent computes volatility-adjusted
> position limits from historical price data; our demo runs without a
> historical-price service so we substitute deterministic concentration
> caps. Same pattern (Risk Manager runs after analysts, before PM
> finalizes), different math.

The Risk Manager is **not** an LLM call. It's the second half of
`scripts/aggregate.mjs`, applying hard caps to the PM's confidence-
weighted weights. This file documents the rules so the LLM (when
narrating to chat) and humans can audit them.

## Rules applied (in order)

1. **Long-tail cap.** All tokens flagged `tail: true` in the basket
   (set by `scripts/research.mjs` for any token with mcap < $10M) sum
   to ≤ `--max-longtail` (default 10%) of the portfolio. Excess is
   redistributed pro-rata to non-tail tokens (excluding any stable
   sleeve in the basket).
2. **Single-asset cap.** No single non-stable asset may exceed
   `--max-single` (default 50%) of the portfolio. Excess is
   redistributed pro-rata to other non-stable, non-tail tokens.
3. **Normalization.** Final weights renormalized to sum to 1.0 exactly.

> **No USDC floor in V1.** The original draft enforced a 10% USDC
> floor for rebalance liquidity. The user opted for a fully dynamic
> basket where research picks all 5 slots — including the cash sleeve
> if (and only if) USDC ranks high enough. Some cycles will have no
> stable. Trade-off accepted: more genuine per-cycle alpha, weaker
> next-cycle liquidity. Re-enable via `--usdc-floor 0.10` if a
> live cycle illiquidates the vault.

## Why these caps (vs upstream's volatility-based sizing)

- **Long-tail cap** prevents a single memecoin signal from blowing up
  the demo's blast radius when research surfaces a high-attention
  low-mcap token. (Upstream uses VaR / vol-adjusted sizing for this.)
- **Single-asset cap** preserves narrative diversification — the
  showcase loses meaning if one persona's max-conviction position
  blows past 80%. (Upstream uses correlation matrices to do something
  similar.)

The deterministic-cap approach is a demo-grade substitute for upstream's
historical-price-and-volatility approach, which would require a Base
token price feed integration we're explicitly not building for V1.

## What the Risk Manager does NOT do

- It does not second-guess the personas' directional views.
- It does not adjust `confidence` values.
- It does not introduce assets the personas didn't grade.
- It does not consider current vault state — only the personas' target.
- It does not compute volatility, VaR, or correlation matrices (gap
  vs upstream).
- It does not enforce a stable-coin floor in V1 (see callout above).

The Portfolio Manager step (also in `aggregate.mjs`) handles
confidence-weighted aggregation across personas. Risk caps are applied
**after** PM aggregation.
