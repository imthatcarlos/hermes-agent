# `hedge-fund` Hermes skill

A multi-persona hedge-fund cycle for the **zerohumanfund** Sherwood
syndicate on Base mainnet. Three investor personas (Buffett, Wood,
Burry) grade a small basket of Base ERC-20s; a deterministic Risk
Manager + Portfolio Manager aggregate into target weights; the agent
submits a Sherwood `PortfolioStrategy` proposal that swaps via Uniswap.

The whole cycle is broadcast to the syndicate's public XMTP chat —
that's the showcase.

## Provenance

The Buffett / Wood / Burry **persona system prompts are reproduced
verbatim** from
[virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)
(`src/agents/{warren_buffett,cathie_wood,michael_burry}.py`,
educational use). Each `personas/*.md` cites its upstream source.

What is **this skill's** original work:
- The crypto-context adaptation of each persona prompt.
- The per-basket output schema (5 tokens at once vs. upstream's
  per-ticker call pattern).
- `scripts/aggregate.mjs` (deterministic concentration caps + equal-
  weighted persona aggregation) — replaces upstream's LLM-based PM
  and volatility-based risk sizing.
- The Sherwood `proposal create` integration.
- The XMTP chat broadcast envelope shape.

## Layout

```
skills/hedge-fund/
├── SKILL.md                         # entry point — what Hermes loads
├── README.md                        # this file
├── personas/
│   ├── buffett.md                   # value lens (verbatim upstream system prompt)
│   ├── wood.md                      # innovation lens (verbatim upstream system prompt)
│   ├── burry.md                     # contrarian lens (verbatim upstream system prompt)
│   ├── risk-manager.md              # deterministic caps reference
│   └── pm.md                        # confidence-weighted aggregation reference
└── scripts/
    ├── aggregate.mjs                # PM + Risk Manager (deterministic)
    └── tokens.json                  # USDC, cbBTC, WETH, AERO, DEGEN on Base
```

At runtime, this skill lives at `/opt/data/skills/finance/hedge-fund/`
inside the Hermes container (the Dockerfile bakes it at
`/opt/skills/hedge-fund` and the entrypoint symlinks).

Per-cycle artifacts go to
`/opt/data/skills/finance/hedge-fund/cycles/<CYCLE_ID>/{signals/,target-weights.json}`.

## Cycle flow (as orchestrated by SKILL.md)

1. Preflight (sherwood + venice + syndicate registration).
2. Open cycle, post header to XMTP.
3. Read basket from `tokens.json`.
4. Three persona LLM calls (Buffett → Wood → Burry); each emits a JSON
   object with `signal` + `confidence` per token; each result posted
   to XMTP as a markdown card.
5. Run `aggregate.mjs` (signals → weights, caps applied); post target
   weights + adjustments to XMTP.
6. Read vault; post deltas to XMTP.
7. **Stop here on `--dry-run`.**
8. Confirm with user in chat.
9. `sherwood proposal create --strategy portfolio --weights @target-weights.json`.
10. Post Basescan link to XMTP. Sherwood plugin auto-posts approval/
    execution lifecycle from there.

## Local development

The aggregator is the only piece you can exercise locally without a
Sherwood + Venice setup. Synthetic test:

```bash
mkdir -p /tmp/hf/signals && cd /tmp/hf
# create 3 persona signal files following the schema in any personas/*.md
node /path/to/skills/hedge-fund/scripts/aggregate.mjs \
    --signals signals/buffett.json signals/wood.json signals/burry.json \
    --tokens /path/to/skills/hedge-fund/scripts/tokens.json \
    --max-single 0.5 --max-longtail 0.10 --usdc-floor 0.10 \
    --out target-weights.json
jq . target-weights.json
```

The aggregator validates each persona JSON against the schema (signals
in {bullish,neutral,bearish}; confidence in [0,100]; reasoning ≤ 240
chars; all five tokens present). Schema violations exit with non-zero.

## Risk caps (defaults)

| Cap | Default | What it does |
|---|---|---|
| `--max-single` | 0.50 | No single non-USDC asset > 50% |
| `--max-longtail` | 0.10 | All `tail: true` tokens combined ≤ 10% |
| `--usdc-floor` | 0.10 | USDC ≥ 10% (preserves rebalance liquidity) |

See `personas/risk-manager.md` for the full design rationale.

## Editing the basket

`scripts/tokens.json` is the source of truth. Adding a token requires:
1. Verified Base mainnet address.
2. Token decimals.
3. `tail: true` if it's a long-tail asset (memecoin, low-cap).
4. Update each persona's prompt body to mention the new token.
5. Update SKILL.md's basket reference (currently hard-codes
   "USDC · cbBTC · WETH · AERO · DEGEN").

The aggregator handles arbitrary basket sizes — no math hardcodes 5.

## Limitations

- **No on-chain context fetch.** Personas reason from training-data
  priors on each token, not live TVL/volume/sentiment. Adding a
  `scripts/fetch-context.mjs` (Defillama + Coingecko) would let
  personas cite current numbers — out of scope for V1.
- **No backtest.** Demo only. Don't extrapolate to performance.
- **No multi-vote consensus.** Equal weighting across personas
  (Buffett = Wood = Burry). Upstream supports per-agent confidence
  weights at aggregation; we keep it simple for the demo.
- **Not a real fund.** $100 demo capital. Educational use.
