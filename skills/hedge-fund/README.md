# `hedge-fund` Hermes skill

A multi-persona hedge-fund cycle for the **zerohumanfund** Sherwood
syndicate on Base mainnet. Three investor personas (Buffett, Wood,
Burry) grade a small basket of Base ERC-20s; a deterministic Risk
Manager + Portfolio Manager aggregate into target weights; the agent
submits a Sherwood `PortfolioStrategy` proposal that swaps via Uniswap.

The basket is **discovered dynamically each cycle** by a research step
that calls CoinGecko's AI Agent Hub and Checkr Social over x402
micropayments — no hand-curated token list. The whole cycle is
broadcast to the syndicate's public XMTP chat.

## Provenance

The Buffett / Wood / Burry **persona system prompts are reproduced
verbatim** from
[virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)
(`src/agents/{warren_buffett,cathie_wood,michael_burry}.py`,
educational use). Each `personas/*.md` cites its upstream source.

What is **this skill's** original work:
- The lens-only crypto-context adaptation of each persona prompt.
- The per-basket output schema (N tokens at once vs. upstream's
  per-ticker call pattern).
- `scripts/research.mjs` (x402-paid discovery via CoinGecko + Checkr).
- `scripts/aggregate.mjs` (deterministic concentration caps + equal-
  weighted persona aggregation, dynamic stable detection) — replaces
  upstream's LLM-based PM and volatility-based risk sizing.
- The Sherwood `proposal create` integration.
- The XMTP chat broadcast envelope shape.

## Layout

```
skills/hedge-fund/
├── SKILL.md                         # entry point — what Hermes loads
├── README.md                        # this file
├── personas/
│   ├── buffett.md                   # value lens (verbatim upstream system prompt + lens-only adaptation)
│   ├── wood.md                      # innovation lens
│   ├── burry.md                     # contrarian lens
│   ├── risk-manager.md              # deterministic caps reference
│   └── pm.md                        # confidence-weighted aggregation reference
└── scripts/
    ├── research.mjs                 # x402 discovery (CoinGecko + Checkr) — produces basket.json
    ├── cycle.mjs                    # persona-round orchestrator (1 LLM call per persona; ≥2-persona threshold)
    ├── aggregate.mjs                # PM + Risk Manager (deterministic; vol-weighted single-asset cap optional)
    ├── tokens.json                  # legacy static fallback — not loaded in V1
    └── package.json                 # @x402/fetch + @x402/evm + viem (installed at container build)
```

At runtime, this skill lives at `/opt/data/skills/finance/hedge-fund/`
inside the Hermes container (the Dockerfile bakes it at
`/opt/skills/hedge-fund` and the entrypoint symlinks).

Per-cycle artifacts go to
`/opt/data/skills/finance/hedge-fund/cycles/<CYCLE_ID>/{basket.json,signals/,target-weights.json}`.

## Cycle flow (as orchestrated by SKILL.md)

1. Preflight: sherwood + syndicate registration + `sherwood strategy
   list | grep portfolio` (catch wrong strategy name early).
2. Open cycle, post header to XMTP.
3. **Discover basket** via `scripts/research.mjs` (x402 calls). Output
   `cycles/<id>/basket.json`. Post a research card to chat.
4. **Persona round via `scripts/cycle.mjs`** — one isolated LLM call
   per persona through the Hermes gateway. Each persona's prompt
   includes the lens template + the basket as a markdown table with
   per-token research metadata (mcap, vol, attention, signal, sources)
   so personas cite concrete numbers. Auto-retries on JSON validation
   errors; aborts the cycle if < 2 personas produce valid signals.
5. Run `aggregate.mjs --tokens basket.json --vol-weight 0.5` (signals
   → weights, caps + vol-weighted sizing applied); post target weights
   + adjustments to XMTP.
6. Read vault; post deltas to XMTP.
7. **Stop here on `--dry-run`.**
8. Confirm with user in chat.
9. `sherwood proposal create --strategy portfolio --weights @target-weights.json`.
10. Post Basescan link to XMTP. Sherwood plugin auto-posts approval/
    execution lifecycle from there.
11. **After settlement** (days later, async): Sherwood plugin emits a
    `<sherwood-settlement>` block with a `REMEMBER THIS` marker. Persist
    cycle outcome (basket, weights, signals, P&L, lesson) via the
    Hermes `memory` tool tagged `hedge-fund` + `zerohumanfund`. Future
    cycles recall the last 4 weeks at preflight and feed it to personas
    so the fund actually learns over time.

## Cost per cycle (x402)

| Call | Provider | Approx cost |
|---|---|---|
| `trending_pools?duration=24h` | CoinGecko | $0.01 USDC |
| `leaderboard?hours=24&limit=20` | Checkr Social | $0.05 USDC |
| `signal?limit=10` | Checkr Social | $0.15 USDC |
| `simple/networks/base/token_price/<addrs>` (bulk) | CoinGecko | $0.01 USDC |
| **Total per research step** | | **~$0.22 USDC** |

Weekly cycle → ~$11/yr in research. Trivial. The `AGENT_PRIVATE_KEY`
wallet (already on Railway) pays — fund it with **at least $5 USDC on
Base** before the first cycle, monitor balance via Basescan.

Inference cost (persona LLM calls + skill orchestration) is whatever
your Hermes provider charges (Venice / Anthropic / etc.) and is
unrelated to the x402 spend.

## Local development

The aggregator is the only piece you can exercise locally without a
Sherwood + Venice + USDC-on-Base setup. Synthetic test:

```bash
mkdir -p /tmp/hf/signals && cd /tmp/hf
# create basket.json + 3 persona signal files following the schemas
node /path/to/skills/hedge-fund/scripts/aggregate.mjs \
    --signals signals/buffett.json signals/wood.json signals/burry.json \
    --tokens basket.json \
    --max-single 0.5 --max-longtail 0.10 \
    --out target-weights.json
jq . target-weights.json
```

The aggregator validates each persona JSON against the schema (signals
in {bullish,neutral,bearish}; confidence in [0,100]; reasoning ≤ 240
chars; all basket tokens present). Schema violations exit with
non-zero.

`research.mjs` requires `AGENT_PRIVATE_KEY` env + USDC balance on Base
+ network access to CoinGecko + Checkr. Use `--dry-run` to verify
wiring without paying:

```bash
cd /opt/data/skills/finance/hedge-fund/scripts
AGENT_PRIVATE_KEY=$AGENT_PRIVATE_KEY node research.mjs --dry-run
```

## Risk caps (defaults)

| Cap | Default | What it does |
|---|---|---|
| `--max-single` | 0.50 | No single non-stable asset > 50% (uniform cap) |
| `--max-longtail` | 0.10 | All `tail: true` tokens combined ≤ 10% |
| `--usdc-floor` | 0 | **Stable floor disabled in V1.** Pass `--usdc-floor 0.10` to enforce a 10% combined stable position (USDC/USDT/EURC/DAI/etc., detected dynamically from the basket). |
| `--vol-weight` | 0 | **Vol-weighted single-asset cap.** Pass e.g. `--vol-weight 0.5` to add a per-token cap of `min(maxSingle, 0.5 * sqrt(mcap_usd / $100M))`. Big-mcap tokens stay at maxSingle; small-mcap tokens get a tighter cap (a $1M-mcap token caps near 5%). Plus a 50% liquidity penalty when 24h-vol/mcap > 0.5 (catches wash trading / illiquid). SKILL.md V1 enables this with K=0.5. |

"Stable" tokens are detected by symbol pattern (`USDC|USDT|EURC|DAI|FRAX|USDe|...`) or by an explicit `stable: true` flag in the basket JSON. The hardcoded "USDC" assumption from V0 is gone — the dynamic basket may have any stable, or none.

See `personas/risk-manager.md` for the full design rationale.

## Editing the basket

The basket is normally written by `scripts/research.mjs` per cycle.
You only need to edit `scripts/tokens.json` (the static fallback) for:
- Local aggregator smoke-tests without paying for x402 calls.
- Manual override flow if research is broken and you want to ship a
  cycle anyway (NOT the V1 default — see Safety rule #6).

If editing `tokens.json` for a smoke test:
1. Verified Base mainnet address.
2. Token decimals.
3. `tail: true` if it's a long-tail asset (memecoin, low-cap).

The aggregator handles arbitrary basket sizes — no math hardcodes 5
or USDC-by-name.

## Limitations

- **Research data is best-effort.** CoinGecko trending pools weight
  by 24h volume which is gameable; Checkr Social leans on social-
  attention which spikes on hype. The merge/score logic in
  `research.mjs` weights volume 0.5 + attention 0.3 + signal 0.2 —
  tune in the script if you see junk picks.
- **No backtest.** Demo only. Don't extrapolate to performance.
- **No multi-vote consensus.** Equal weighting across personas
  (Buffett = Wood = Burry). Upstream supports per-agent confidence
  weights at aggregation; we keep it simple for the demo.
- **No stable floor in V1.** Some cycles may end up 100% non-stable,
  which leaves the vault unable to rebalance into anything for the
  next cycle. Re-enable via `--usdc-floor` if this bites in practice.
- **Not a real fund.** ~$100 demo capital. Educational use.
