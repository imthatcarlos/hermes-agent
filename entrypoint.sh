#!/bin/bash
# zerohumanfund Hermes entrypoint.
#
# Runs as root and stays root through all init, then chains to the upstream
# /opt/hermes/docker/entrypoint.sh which handles the gosu drop to the hermes
# user (UID 10000). Doing it this way means we control file ownership before
# upstream chowns the volume, and our writes (config.yaml, sherwood config)
# land with the right ownership the first time.
#
# Steps:
#   1. chown -R hermes:hermes /opt/data — Railway mounts the volume root-owned;
#      hermes user can't mkdir into it otherwise.
#   2. chown -R hermes:hermes /opt/skills — so hermes can read the baked skill.
#   3. Symlink the baked /opt/skills/hedge-fund into the volume's
#      /opt/data/skills/finance/hedge-fund.
#   4. (idempotent) Write /opt/data/config.yaml from OPENAI_API_KEY +
#      HERMES_MODEL env vars if both are set and config.yaml is absent.
#      File is chmod 640, hermes:hermes.
#   5. (idempotent) Run `sherwood config set` as the hermes user (via gosu)
#      so the resulting /opt/data/.sherwood/config.json is written under
#      hermes' HOME with the right ownership.
#   6. exec /opt/hermes/docker/entrypoint.sh "$@" — upstream sees root,
#      detects /opt/data is already hermes-owned (skips its chown), drops
#      to hermes, then exec hermes "$@" (we set CMD=["gateway","run"]).
set -e

HERMES_HOME="${HERMES_HOME:-/opt/data}"
SKILL_SRC=/opt/skills/hedge-fund
SKILL_DST="$HERMES_HOME/skills/finance/hedge-fund"

# We expect to be invoked as root. If somehow we're not, just chain through —
# upstream entrypoint may still bail with the same permissions issue.
if [ "$(id -u)" != "0" ]; then
    exec /opt/hermes/docker/entrypoint.sh "$@"
fi

# Step 1+2: ownership.
chown -R hermes:hermes "$HERMES_HOME" 2>/dev/null || true
chown -R hermes:hermes /opt/skills 2>/dev/null || true

# Step 3: skill symlink.
mkdir -p "$HERMES_HOME/skills/finance"
ln -sfn "$SKILL_SRC" "$SKILL_DST"
chown -h hermes:hermes "$SKILL_DST" 2>/dev/null || true

# Step 4: Hermes inference config (only on first boot).
if [ ! -f "$HERMES_HOME/config.yaml" ] && [ -n "${OPENAI_API_KEY:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
    BASE_URL="${OPENAI_BASE_URL:-https://api.venice.ai/api/v1}"
    cat > "$HERMES_HOME/config.yaml" <<EOF
model:
  provider: custom
  model: ${HERMES_MODEL}
  base_url: ${BASE_URL}
  api_key: ${OPENAI_API_KEY}
EOF
    chown hermes:hermes "$HERMES_HOME/config.yaml"
    chmod 640 "$HERMES_HOME/config.yaml"
fi

# Step 5: Sherwood config (only on first boot). Run as hermes via gosu so
# `sherwood config set` writes to /opt/data/.sherwood/config.json (hermes'
# HOME is /opt/data per upstream Dockerfile useradd).
if [ -n "${AGENT_PRIVATE_KEY:-}" ] && [ ! -f "$HERMES_HOME/.sherwood/config.json" ] && command -v sherwood >/dev/null 2>&1; then
    gosu hermes sherwood config set \
        --private-key "$AGENT_PRIVATE_KEY" \
        --rpc "${BASE_RPC_URL:-https://base-rpc.publicnode.com}" \
        >/dev/null 2>&1 || echo "warning: 'sherwood config set' failed; check CLI surface"
fi

# Step 6: chain to upstream (still root, upstream gosu-drops to hermes).
exec /opt/hermes/docker/entrypoint.sh "$@"
