---
name: hedge-fund
description: Run a multi-persona hedge-fund cycle (Buffett, Wood, Burry + Risk Manager + Portfolio Manager) against the zerohumanfund Sherwood syndicate on Base. Each persona grades the on-chain token basket; the Risk Manager applies deterministic concentration caps; the PM produces target weights and submits a Sherwood PortfolioStrategy proposal. Use when the user says "run the fund", "rebalance zerohumanfund", "run a hedge-fund cycle", "/hedge-fund", or when fired by cron.
metadata:
  hermes:
    tags: [hedge-fund, sherwood, base, venice, demo]
    category: finance
required_environment_variables:
  - name: AGENT_PRIVATE_KEY
    description: EVM private key for the Sherwood proposer wallet (registered with zerohumanfund). Never logged. Never echoed to chat.
  - name: BASE_RPC_URL
    description: Base mainnet RPC endpoint (e.g. https://base-rpc.publicnode.com). Used by Sherwood CLI.
  - name: OPENAI_API_KEY
    description: Venice API key (provisioned via `sherwood venice provision`). Used by Hermes for the persona prompts.
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
fails.

```bash
sherwood --version || echo "FAIL: sherwood CLI missing"
sherwood identity status || echo "FAIL: no Sherwood identity"
sherwood syndicate info zerohumanfund | jq -r '.agents[]?' \
    | grep -i "$(sherwood config show | jq -r '.address')" \
    || echo "FAIL: agent wallet not registered with zerohumanfund"
sherwood venice status | jq -r '.apiKey // empty' \
    || echo "FAIL: no Venice API key — run sherwood venice provision"
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
Personas: Buffett · Wood · Burry. Risk + PM after. Target basket: USDC · cbBTC · WETH · AERO · DEGEN." \
    --markdown
```

### Step 3 — Load the basket

Read `scripts/tokens.json` from this skill directory. Five tokens with
Base addresses + decimals + tail flag.

```bash
cd /opt/data/skills/finance/hedge-fund
cat scripts/tokens.json
```

### Step 4 — Persona round

For each of `buffett`, `wood`, `burry` in that order:

1. Read `personas/<name>.md` (the lens prompt for this persona).
2. Generate the persona's view by reasoning *as that persona* about all
   five tokens at once. Output exactly the JSON schema the persona file
   declares — `signal` ∈ `{"bullish","bearish","neutral"}` per token,
   `confidence` 0–100, `reasoning` ≤ 240 chars per token. No prose
   outside the JSON object.
   ```json
   {
     "persona": "warren-buffett",
     "signals": [
       {"token":"USDC","signal":"bullish","confidence":90,"reasoning":"..."},
       {"token":"cbBTC","signal":"neutral","confidence":55,"reasoning":"..."},
       {"token":"WETH","signal":"neutral","confidence":40,"reasoning":"..."},
       {"token":"AERO","signal":"bearish","confidence":60,"reasoning":"..."},
       {"token":"DEGEN","signal":"bearish","confidence":95,"reasoning":"..."}
     ]
   }
   ```
3. Validate: all five tokens present in the order USDC, cbBTC, WETH,
   AERO, DEGEN; signal in the allowed set; confidence in [0, 100];
   reasoning ≤ 240 chars. If invalid, retry once with an explicit
   "emit only the JSON object, no prose" instruction. If invalid twice,
   skip the persona (note in the next chat post) and continue.
4. Write the JSON to `cycles/$CYCLE_ID/signals/<name>.json`.
5. Post a short markdown card to the syndicate chat:
   ```bash
   sherwood chat zerohumanfund send "## $PERSONA_DISPLAY_NAME

| token | signal | conf | rationale |
|------|--------|------|-----------|
| USDC | bullish | 90 | Cash floor — preserves optionality. |
| cbBTC | neutral | 55 | ... |
| ... |
" --markdown
   ```

### Step 5 — Risk Manager + PM aggregation

Run the deterministic aggregator. It converts each persona's signals to
weights, runs confidence-weighted aggregation across personas, then
applies concentration caps in one shot.

```bash
cd /opt/data/skills/finance/hedge-fund/cycles/$CYCLE_ID
node ../../scripts/aggregate.mjs \
    --signals signals/buffett.json signals/wood.json signals/burry.json \
    --tokens ../../scripts/tokens.json \
    --max-single 0.5 \
    --max-longtail 0.10 \
    --usdc-floor 0.10 \
    --out target-weights.json
```

Output (`target-weights.json`):
```json
{
  "weights": {"USDC": 0.18, "cbBTC": 0.42, "WETH": 0.30, "AERO": 0.07, "DEGEN": 0.03},
  "adjustments": ["AERO clipped 0.12 → 0.07 (long-tail cap)", "..."],
  "by_persona_normalized": { ... }
}
```

Post a markdown table to chat showing the final weights and any
adjustments the Risk Manager made:

```bash
sherwood chat zerohumanfund send \
    "## Risk + PM result

| token | target | adjustment |
|------|--------|-----------|
| USDC | 18% | floor enforced |
| cbBTC | 42% | — |
| ... |
" --markdown
```

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

## Safety rules

1. **NEVER** echo `AGENT_PRIVATE_KEY` to chat or logs.
2. **NEVER** run `sherwood proposal create` without an explicit
   yes/proceed/confirm from the user in chat.
3. **NEVER** invent token addresses — only use the addresses in
   `scripts/tokens.json`. If the basket needs to change, edit
   `scripts/tokens.json` first.
4. **NEVER** post the same persona's signal twice. If retrying, overwrite
   the JSON file and only post the final card.
5. If a persona's JSON repeatedly fails validation, abort the cycle —
   submitting a proposal with stale or malformed signals would mislead
   observers.

## Files in this skill

- `personas/buffett.md` — value-investing prompt template (verbatim from upstream's `warren_buffett.py`).
- `personas/wood.md` — innovation/disruption prompt template (verbatim from upstream's `cathie_wood.py`).
- `personas/burry.md` — contrarian/risk-off prompt template (verbatim from upstream's `michael_burry.py`).
- `personas/risk-manager.md` — deterministic concentration-cap reference (this skill's adaptation).
- `personas/pm.md` — confidence-weighted aggregation reference (this skill's adaptation).
- `scripts/aggregate.mjs` — Risk Manager + PM, deterministic.
- `scripts/tokens.json` — basket: USDC, cbBTC, WETH, AERO, DEGEN.
- `README.md` — skill-level overview + provenance.
