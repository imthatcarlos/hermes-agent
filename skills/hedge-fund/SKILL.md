---
name: hedge-fund
description: Run a multi-persona hedge-fund cycle (Buffett, Wood, Burry + Risk Manager + Portfolio Manager) against the zerohumanfund Sherwood syndicate on Base. Each persona grades the on-chain token basket; the Risk Manager applies deterministic concentration caps; the PM produces target weights and submits a Sherwood PortfolioStrategy proposal. Use when the user says "run the fund", "rebalance zerohumanfund", "run a hedge-fund cycle", "/hedge-fund", or when fired by cron.
metadata:
  hermes:
    tags: [hedge-fund, sherwood, base, venice, demo]
    category: finance
required_environment_variables:
  - name: AGENT_PRIVATE_KEY
    description: EVM private key for the Sherwood proposer wallet (registered with zerohumanfund). Same wallet pays x402 micropayments for research (~$0.22 USDC/cycle) — must hold USDC on Base. Never logged. Never echoed to chat.
  - name: BASE_RPC_URL
    description: Base mainnet RPC endpoint (e.g. https://base-rpc.publicnode.com). Used by Sherwood CLI and the x402 research script.
  - name: OPENAI_API_KEY
    description: Venice API key (provisioned via `sherwood venice provision` or set manually). Used by Hermes for the persona prompts.
---

# Hedge Fund — multi-persona cycle for zerohumanfund

A single-shot rebalance cycle for the **zerohumanfund** Sherwood
syndicate on Base. Three investor personas (Buffett, Wood, Burry) grade
a small basket of Base tokens via Venice inference; a deterministic Risk
Manager applies concentration caps; the Portfolio Manager aggregates
into target weights and submits a Sherwood PortfolioStrategy proposal.

The whole cycle is broadcast to the syndicate's public XMTP chat —
that's the showcase.

> **Persona prompt provenance:** Buffett / Wood / Burry system prompts
> are reproduced verbatim from
> [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund)
> (educational use). Each `personas/*.md` file cites the upstream source
> file. The crypto-context adaptations and the per-basket output schema
> are this skill's own work.

## When to use

- User says "run the fund", "rebalance zerohumanfund", "run a hedge-fund cycle", "kick off a cycle".
- User invokes `/hedge-fund` or `/hedge-fund --dry-run`.
- Fired by Hermes cron with a self-contained prompt referencing this skill.

## Inputs

- `--dry-run` (optional): run the full cycle but skip the on-chain
  proposal submission. Use this for the very first invocation.

## Procedure

Follow these steps **in order**. Do not skip steps. Each step's output
is the input to the next.

### Step 1 — Preflight

Verify the runtime is healthy. Bail with a clear chat post if anything
fails. Note: **inference is not checked** — the fact that the LLM is
interpreting this skill is itself proof Hermes inference is working
(via whatever provider Hermes is configured with).

```bash
sherwood --version || echo "FAIL: sherwood CLI missing"
sherwood identity status || echo "FAIL: no Sherwood identity"
sherwood syndicate info zerohumanfund | jq -r '.agents[]?' \
    | grep -i "$(sherwood config show | jq -r '.address')" \
    || echo "FAIL: agent wallet not registered with zerohumanfund"

# Verify the strategy template name we'll use in Step 8 actually exists on
# this network. The template name has shifted across Sherwood versions
# ("portfolio", "portfolio-v3", "aerodrome-lp" all surface in different
# releases). Reading from `sherwood strategy list` once at preflight
# catches a misnamed --strategy flag before we burn 6 personas + research
# spend on a cycle that can't submit.
sherwood strategy list | grep -E '^\s*portfolio\b' \
    || echo "FAIL: 'portfolio' strategy template not found — run 'sherwood strategy list' to find the current name and update Step 8"
```

If any FAIL: post a single concise message to the syndicate chat naming
what's missing, and stop.

```bash
sherwood chat zerohumanfund send \
    "Cycle aborted: <one-line reason>" --markdown
```

### Step 2 — Open the cycle

```bash
CYCLE_ID="$(date -u +%Y-%m-%dT%H%MZ)"
mkdir -p "/opt/data/skills/finance/hedge-fund/cycles/$CYCLE_ID/signals"
sherwood chat zerohumanfund send \
    "## Cycle $CYCLE_ID opened
Personas: Buffett · Wood · Burry. Risk + PM after. Discovering basket via x402 research…" \
    --markdown
```

### Step 3 — Discover this cycle's basket (x402 research)

Run `scripts/research.mjs` to discover the top-N Base tokens via
CoinGecko (trending pools) + Checkr Social (attention + signal radar)
over x402 micropayments. **Costs ~$0.22 USDC per cycle** — the agent
wallet (`AGENT_PRIVATE_KEY`) must hold USDC on Base.

```bash
cd /opt/data/skills/finance/hedge-fund
node scripts/research.mjs --execute --top-n 5 \
    --out "cycles/$CYCLE_ID/basket.json"
```

Output (`basket.json`) is consumed by both the persona round (Step 4)
and the aggregator (Step 5). Shape:
```json
{
  "tokens": [
    {"symbol":"VIRTUAL","address":"0x0b3e...","decimals":18,"tail":false,"mcap_usd":3e9,"vol24_usd":...,"attention_pct":...,"signal_score":...,"score":0.79,"sources":["coingecko","checkr-leaderboard"]},
    ...5 tokens total
  ],
  "research_summary": {...}
}
```

Post a research card to chat naming the picks + why each was chosen
(cite `sources`, `mcap_usd`, `attention_pct`):
```bash
sherwood chat zerohumanfund send "## Cycle $CYCLE_ID — basket

| token | mcap | 24h vol | sources | score |
|------|------|---------|---------|-------|
| VIRTUAL | \$3.0B | \$80M | coingecko + checkr | 0.79 |
| ... |
" --markdown
```

If `research.mjs` fails (Coingecko 4xx, Checkr down, USDC balance
empty), **abort the cycle** and post the failure to chat — do not
silently fall back to the static `scripts/tokens.json` (which is
boilerplate and would mislead observers).

### Step 4 — Persona round (delegated to `scripts/cycle.mjs`)

The persona round is **not** done in this LLM turn. Instead, shell out
to `scripts/cycle.mjs`, which makes one isolated LLM call per persona
through the Hermes OpenAI-compatible gateway. Each persona gets a clean
context, the full lens prompt, and the basket + per-token research
metadata literally injected as a markdown table — so e.g. Burry can
cite `mcap=$3.0B, vol=$80M, attention=4.2%` instead of guessing.

Why split it out: a single LLM turn that role-plays 3 personas in
sequence (each emitting strict JSON) drifts on schemas and forgets
constraints by the third pass. Per-persona isolated calls eliminate
that failure mode.

```bash
cd /opt/data/skills/finance/hedge-fund
node scripts/cycle.mjs \
    --basket "cycles/$CYCLE_ID/basket.json" \
    --personas buffett wood burry \
    --personas-dir personas \
    --out-dir "cycles/$CYCLE_ID/signals" \
    --gateway-url "${API_SERVER_URL:-http://127.0.0.1:8642}" \
    --gateway-key "$API_SERVER_KEY" \
    --model "$HERMES_MODEL"
```

Behavior:
- One LLM call per persona, executed sequentially.
- Each response is parsed; if JSON is wrapped in markdown fences,
  unwrapped automatically. Schema violations trigger one retry with
  a corrective hint. If still invalid, the persona is skipped.
- Writes one `signals/<name>.json` per valid persona.
- Writes a manifest `cycles/<id>/persona-round.json` summarizing
  which personas succeeded vs failed.
- **Exits non-zero if fewer than 2 personas produced valid signals.**
  This makes the skill abort the cycle rather than letting one persona
  drive the consensus alone.

After cycle.mjs returns successfully, post a markdown card per valid
persona to the syndicate chat (one row per basket token, columns:
signal, confidence, rationale). Read the manifest to know which
signal files to use in Step 5.

### Step 5 — Risk Manager + PM aggregation

Run the deterministic aggregator. Use the signal files listed in the
manifest from Step 4.

```bash
cd /opt/data/skills/finance/hedge-fund/cycles/$CYCLE_ID
node ../../scripts/aggregate.mjs \
    --signals $(jq -r '.signal_files | join(" ")' persona-round.json) \
    --tokens basket.json \
    --max-single 0.5 \
    --max-longtail 0.10 \
    --vol-weight 0.5 \
    --out target-weights.json
```

The default risk caps in V1:
- `--max-single 0.5` — no single non-stable asset > 50%.
- `--max-longtail 0.10` — sum of `tail:true` tokens ≤ 10%.
- `--vol-weight 0.5` — vol-weighted single-asset cap on top of
  `--max-single`. Per-token cap = min(0.5, 0.5 / sqrt(mcap_usd / $100M)),
  with a 50% liquidity penalty if 24h-volume / mcap > 0.5. Smaller
  mcap → tighter cap. Set to 0 to disable and use plain --max-single.
- No stable floor by default (the basket may not contain any stable;
  pass `--usdc-floor 0.10` if you've confirmed a stable is present
  and want to enforce a cash sleeve).

Output (`target-weights.json`):
```json
{
  "weights": {"<sym1>": 0.32, "<sym2>": 0.31, "<sym3>": 0.26, "<sym4>": 0.06, "<sym5>": 0.05},
  "adjustments": ["<sym4> clipped 0.19 → 0.06 (long-tail cap)", "..."],
  "persona_notes": {"warren-buffett": "all-bearish/neutral → no stable in basket, fell back to equal-weight"},
  "by_persona_normalized": { ... }
}
```

Post a markdown table to chat showing the final weights, the source of
each token (research provenance from basket.json), and any adjustments
the Risk Manager made.

### Step 6 — Vault diff

Read the vault's current holdings and compute deltas vs target.

```bash
sherwood vault info zerohumanfund | jq '.balances'
```

Compute `target_usd - current_usd` per token, post a deltas summary to
chat (which tokens the proposal would buy/sell and roughly how much).

**If invoked with `--dry-run`: stop here.** Post a "dry-run complete"
message and exit cleanly.

### Step 7 — User confirmation (REQUIRED before proposal)

`sherwood proposal create` writes on-chain and pins to IPFS. Per
Sherwood's own SKILL.md: gas is paid and the proposal cannot be edited
once it enters the voting window. **Always require explicit confirmation
in chat before this step.**

Ask the user:
```
Submit Sherwood PortfolioStrategy proposal for zerohumanfund with the target weights above? (yes / no)
```

Wait for an affirmative reply (`yes`, `proceed`, `confirm`). On `no` or
anything else, post "Cycle ended without proposal." and exit.

### Step 8 — Submit the proposal

```bash
sherwood proposal create \
    --syndicate zerohumanfund \
    --strategy portfolio \
    --weights @target-weights.json \
    --duration 7d
```

Capture the proposal id and Basescan link. Post to chat:
```bash
sherwood chat zerohumanfund send \
    "## Proposal submitted
- Proposal id: \`$PROPOSAL_ID\`
- Basescan: $BASESCAN_LINK
- Voting opens shortly. Owner-multisig will vote and execute." --markdown
```

The Sherwood Hermes plugin auto-posts proposal-lifecycle summaries
(approved / executed / settled) to the chat — no further work needed
from this skill.

### Step 9 — Persist cycle memory (after settlement)

After the syndicate settles the proposal (days later, asynchronously),
the Sherwood Hermes plugin emits a `<sherwood-settlement>` block in
your context with a `REMEMBER THIS` marker. **Always honor the marker**
by writing a memory entry that captures:

- `cycle_id`, basket symbols + addresses, target weights vs realized,
  per-persona signals + confidences, P&L on settlement, fee paid.
- A 1-line lesson ("AERO outperformed despite Burry's bearish call
  with confidence 80 — recalibrate Burry's DEX-governance prior").

Use the Hermes `memory` tool. Tag entries with `hedge-fund` and
`zerohumanfund` so they're easy to recall in future cycles. Future
cycles should `memory recall --tags hedge-fund` at preflight and
include the last 4 weeks of summaries in the persona context — the
personas can then reason about regime ("we held VIRTUAL last 3 weeks
and it underperformed; downweight").

This loop is what turns the demo into something that actually compounds.

## Safety rules

1. **NEVER** echo `AGENT_PRIVATE_KEY` to chat or logs.
2. **NEVER** run `sherwood proposal create` without an explicit
   yes/proceed/confirm from the user in chat.
3. **NEVER** invent token addresses — only use the addresses returned
   by `scripts/research.mjs` (or the static fallback in `scripts/tokens.json`
   if explicitly invoked with `--no-research`, which V1 does not do).
4. **NEVER** post the same persona's signal twice. If retrying, overwrite
   the JSON file and only post the final card.
5. If a persona's JSON repeatedly fails validation, abort the cycle —
   submitting a proposal with stale or malformed signals would mislead
   observers.
6. If `scripts/research.mjs` fails (network, x402 401/402 misalignment,
   USDC balance empty), **abort the cycle** and post the failure to
   chat. Do not silently fall back to a stale or hardcoded basket.
7. The agent wallet must hold USDC on Base for x402 payments
   (~$0.22/cycle). Monitor balance via the legacy `EVM_PRIVATE_KEY`
   wallet's USDC balance on Basescan.

## Files in this skill

- `personas/buffett.md` — value-investing prompt template (verbatim from upstream's `warren_buffett.py`).
- `personas/wood.md` — innovation/disruption prompt template (verbatim from upstream's `cathie_wood.py`).
- `personas/burry.md` — contrarian/risk-off prompt template (verbatim from upstream's `michael_burry.py`).
- `personas/risk-manager.md` — deterministic concentration-cap reference (this skill's adaptation).
- `personas/pm.md` — confidence-weighted aggregation reference (this skill's adaptation).
- `scripts/research.mjs` — discovery via x402 (CoinGecko trending pools + Checkr Social leaderboard + signal radar). ~$0.22 USDC/cycle.
- `scripts/cycle.mjs` — persona-round orchestrator. Calls the Hermes gateway once per persona with isolated context + injected basket metadata; validates JSON; writes signal files + manifest. Exits non-zero if < 2 personas produce valid signals.
- `scripts/aggregate.mjs` — Risk Manager + PM, deterministic. Supports vol-weighted single-asset cap (`--vol-weight K`).
- `scripts/package.json` — declares `@x402/fetch` + `@x402/evm` + `viem` for `research.mjs`. Installed at container build via Dockerfile.
- `scripts/tokens.json` — static fallback basket (legacy boilerplate); **not used in V1** when research.mjs succeeds.
- `README.md` — skill-level overview + provenance + x402 cost notes.
