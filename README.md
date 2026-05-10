# zerohumanfund — Hermes-on-Railway demo

A 24/7 AI hedge fund running on a fresh
[Hermes](https://github.com/NousResearch/hermes-agent) container hosted
on Railway. Three investor personas (Buffett, Wood, Burry) grade a
small basket of Base ERC-20s; a deterministic Risk Manager + Portfolio
Manager aggregate; the agent submits a Sherwood `PortfolioStrategy`
proposal that swaps via Uniswap. The whole debate is broadcast to the
syndicate's public XMTP chat — that's the showcase.

> Demo, not product. ~$100 capital. Persona prompts adapted (with
> credit) from [virattt/ai-hedge-fund]. Full provenance in
> `skills/hedge-fund/README.md`.

[virattt/ai-hedge-fund]: https://github.com/virattt/ai-hedge-fund

## Stack

| Layer | Component |
|---|---|
| Container | `nousresearch/hermes-agent:latest` (overlay adds Node 20 + `@sherwoodagent/cli` + the `hedge-fund` skill) |
| Host | Railway, single service, single 5+ GB volume mounted at `/opt/data` |
| LLM provider | Venice (sVVV staked → API key via `sherwood venice provision`) |
| Chain | Base mainnet (chain 8453) |
| Wallet | EVM agent wallet, registered as proposer for `zerohumanfund` syndicate |
| Vault / governance | Sherwood — `sherwood proposal create --strategy portfolio` from agent → owner-multisig vote → execute |
| Showcase | Public XMTP chat in the `zerohumanfund` syndicate group |

## Repo layout

```
.
├── Dockerfile                       # ~10 lines — overlay on hermes-agent + Node + sherwood CLI + bake skill
├── entrypoint.sh                    # symlink baked skill into /opt/data; write Hermes + Sherwood configs from env; chain to upstream entrypoint
├── railway.toml                     # ports 9119 (dashboard) + 8642 (gateway) + /opt/data volume
├── skills/
│   └── hedge-fund/                  # the custom Hermes skill
│       ├── SKILL.md
│       ├── README.md                # full skill docs incl. provenance
│       ├── personas/
│       │   ├── buffett.md           # verbatim upstream system prompt + crypto adaptation
│       │   ├── wood.md              # idem
│       │   ├── burry.md             # idem
│       │   ├── risk-manager.md      # deterministic concentration caps reference
│       │   └── pm.md                # confidence-weighted aggregation reference
│       └── scripts/
│           ├── aggregate.mjs        # PM + Risk Manager (deterministic)
│           └── tokens.json          # USDC, cbBTC, WETH, AERO, DEGEN on Base
├── solana-swaps/                    # legacy git submodule, reference for Hermes SKILL.md format — not loaded into the new container
├── .clawdbot/                       # legacy clawdbot config — ignored by the new branch
└── CLAUDE.md                        # legacy Sprite runbook — superseded by this README
```

## Railway env vars

Set these on the Railway service before first deploy. Order doesn't
matter at deploy time, but `OPENAI_API_KEY` / `HERMES_MODEL` must be
present before the first `/hedge-fund` invocation, and
`AGENT_PRIVATE_KEY` must be present on first boot for the entrypoint to
seed Sherwood config.

| Var | Required | Purpose |
|---|---|---|
| `HERMES_DASHBOARD` | yes | `1` — enables dashboard side-process |
| `HERMES_DASHBOARD_HOST` | yes | `0.0.0.0` for Railway TCP proxy |
| `HERMES_DASHBOARD_PORT` | yes | `9119` (matches railway.toml) |
| `API_SERVER_ENABLED` | yes | `true` — OpenAI-compatible gateway |
| `API_SERVER_HOST` | yes | `0.0.0.0` |
| `API_SERVER_KEY` | yes | 32+ random chars — bearer auth on the gateway |
| `API_SERVER_CORS_ORIGINS` | yes | `*` (or restrict to dashboard URL later) |
| `AGENT_PRIVATE_KEY` | yes | EVM key for the Sherwood proposer wallet (registered with zerohumanfund). NEVER commit; env var only |
| `BASE_RPC_URL` | yes | e.g. `https://base-rpc.publicnode.com` |
| `OPENAI_API_KEY` | yes | Venice API key (output of `sherwood venice provision`) |
| `OPENAI_BASE_URL` | yes | `https://api.venice.ai/api/v1` |
| `HERMES_MODEL` | yes | a Venice model id from `sherwood venice status` |

## Bring-up procedure

Phases follow the plan at
`/Users/carlos/.claude/plans/i-want-to-ship-fluttering-phoenix.md` —
this README is the runbook.

### Phase 0 — Pre-deploy (off-Railway)

From your local machine where Sherwood CLI is already configured:

```bash
# Confirm syndicate state and register the agent wallet (idempotent)
sherwood syndicate info zerohumanfund | jq '.agents'
sherwood syndicate add --wallet 0xAGENT_ADDRESS    # if missing
sherwood chat zerohumanfund add 0xAGENT_ADDRESS

# Confirm voting period is short enough for a weekly cycle
sherwood governor params zerohumanfund | jq '.votingPeriod'
# If too long, owner-instant: sherwood governor set-voting-period --syndicate zerohumanfund --hours 24

# Confirm vault has demo capital
sherwood vault info zerohumanfund | jq '.balances.USDC'   # ≥ ~100
```

VVV / Venice bootstrap (one-time):

```bash
# 1. Acquire VVV on the agent wallet (DEX or transfer)
# 2. Owner-multisig: propose + execute the venice-inference Sherwood strategy
sherwood proposal create --syndicate zerohumanfund --strategy venice-inference --vvv-amount <amount>
sherwood proposal vote <id> --for
sherwood proposal execute <id>
# 3. Provision API key (will run on Railway, after Phase 1 deploy):
#    railway run -- sherwood venice provision
#    railway run -- sherwood venice status
```

### Phase 1 — Deploy fresh container

```bash
git checkout zerohumanfund   # this branch
railway up
railway logs | grep -E "gateway|dashboard|listening"
```

Open the Railway URL for port 9119 — Hermes dashboard should load.

### Phase 2 — Verify Sherwood baked in + wallet wired

```bash
railway run -- sherwood --version
railway run -- sherwood config show              # agent wallet shown, key masked
railway run -- sherwood identity status          # mint if absent
railway run -- sherwood identity mint --name "ZeroHumanFund Agent"
railway run -- sherwood syndicate info zerohumanfund | jq '.agents'
```

### Phase 3 — Provision Venice key on the container

```bash
railway run -- sherwood venice provision
railway run -- sherwood venice status
```

Then set the inference env vars on Railway (`OPENAI_API_KEY`,
`OPENAI_BASE_URL`, `HERMES_MODEL`) using values from the
`sherwood venice status` output. Restart the service so the entrypoint
picks them up and writes `/opt/data/config.yaml`.

### Phase 4 — Hello

```bash
railway run -- sherwood chat zerohumanfund send \
    "ZeroHumanFund agent online. Will run a demo cycle shortly." --markdown
```

Confirm message lands in the public XMTP group spectator view.

### Phase 5 — Dry-run cycle

From the dashboard chat tab (or curl the gateway):

```
/hedge-fund --dry-run
```

Watch the chat: cycle header → 3 persona cards → risk + PM target
weights → vault diff → "dry-run complete". No on-chain action.

### Phase 6 — First real cycle (manual)

```
/hedge-fund
```

Confirm the proposal in chat (`yes`). Vote with the owner-multisig:

```bash
sherwood proposal info <id>
sherwood proposal vote <id> --for
# wait out voting period
sherwood proposal execute <id>
sherwood vault info zerohumanfund | jq '.balances'
```

### Phase 7 — Cron + polish

After a cycle has run cleanly twice:

```bash
railway run -- hermes cron create "0 17 * * 5" \
  "Run the hedge-fund cycle for zerohumanfund per the skill instructions in /opt/data/skills/finance/hedge-fund/SKILL.md. Post each persona's view, the risk gate, and the PM target weights to the syndicate's XMTP chat. Then proceed with proposal creation per the skill's confirm-before-create pattern." \
  --skill hedge-fund \
  --name "ZeroHumanFund weekly cycle"
```

Optional (if dashboard URL has been shared too widely): re-add Caddy
basic-auth in front of `127.0.0.1:9119` per the legacy
`entrypoint.sh` Caddy block; switch railway.toml to expose the Caddy
port instead of 9119.

## Where to look when something breaks

| Symptom | First place to look |
|---|---|
| Container won't start | `railway logs` — look for entrypoint output |
| `hermes` says no LLM provider | `/opt/data/config.yaml` exists? `OPENAI_API_KEY` + `HERMES_MODEL` set? Restart after setting env vars |
| `sherwood --version` fails | Dockerfile build issue — check `npm i -g @sherwoodagent/cli` ran |
| `sherwood config show` shows no key | `AGENT_PRIVATE_KEY` env var not set on first boot. Set it, then `railway run -- sherwood config set --private-key "$AGENT_PRIVATE_KEY"` to seed |
| Skill not visible to Hermes | `railway run -- ls /opt/data/skills/finance/hedge-fund/` — symlink should resolve to `/opt/skills/hedge-fund/` |
| Cycle aborts on preflight | Persona signals + agent wallet + venice key all required — preflight prints which is missing |
| Persona JSON validation fails | LLM returned prose alongside JSON; retry with explicit "JSON only" instruction (skill handles one auto-retry) |
| Proposal won't submit | `--strategy portfolio` may be wrong name on this Sherwood version. Check `sherwood strategy list` |

## Limitations & honesty

- **Not financial advice.** Educational/research demo only.
- **Tiny capital.** ~$100. Real funds, but trivial blast radius.
- **Persona prompts are not whole-cloth original** — verbatim adapted
  from virattt/ai-hedge-fund (educational use, credited in
  `skills/hedge-fund/README.md` and each `personas/*.md`). The
  orchestration, on-chain integration, and risk math are this repo's
  work.
- **No backtest.** Don't extrapolate cycle outputs to "performance."
- **No on-chain context fetch in V1.** Personas reason from training-
  data priors. A `fetch-context.mjs` adding TVL / volume / sentiment
  is a worthy V2.

## License

Code in this repo (the Dockerfile, entrypoint, railway.toml,
`skills/hedge-fund/scripts/`, `skills/hedge-fund/README.md`,
`skills/hedge-fund/SKILL.md`, the crypto-context sections of each
`personas/*.md`, and this README) — your call as the repo owner.

Persona system prompts inside `skills/hedge-fund/personas/{buffett,
wood,burry}.md` are quoted from
[virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) under
educational use; the upstream repo has no SPDX-listed license so
redistribution rights are limited. Do not relicense those quoted
sections.
