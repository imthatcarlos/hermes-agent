#!/bin/bash
# zerohumanfund Hermes entrypoint.
#
# Runs BEFORE upstream /opt/hermes/docker/entrypoint.sh:
#   1. (as root) ensures /opt/skills + HERMES_HOME ownership lets hermes user write,
#      then re-execs itself as the hermes user via gosu.
#   2. (as hermes) symlinks the baked /opt/skills/hedge-fund into the HERMES_HOME
#      volume (the volume shadows anything baked at /opt/data/skills directly).
#   3. (as hermes) writes ~/.hermes/config.yaml pointing inference at Venice if a
#      Venice key + model are present (idempotent — only on first boot).
#   4. (as hermes) writes ~/.sherwood/config.json from AGENT_PRIVATE_KEY if absent.
#   5. exec /opt/hermes/docker/entrypoint.sh "$@" — chains to upstream, which
#      detects it's already running as hermes and skips its own privilege drop.
set -e

HERMES_HOME="${HERMES_HOME:-/opt/data}"
SKILL_SRC=/opt/skills/hedge-fund
SKILL_DST="$HERMES_HOME/skills/finance/hedge-fund"

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$HERMES_HOME/skills/finance" "$HERMES_HOME/.sherwood"
    chown -R hermes:hermes "$HERMES_HOME/skills" "$HERMES_HOME/.sherwood" 2>/dev/null || true
    chown -R hermes:hermes /opt/skills 2>/dev/null || true
    exec gosu hermes "$0" "$@"
fi

# --- running as hermes user from here ---

ln -sfn "$SKILL_SRC" "$SKILL_DST"

# Hermes inference config: only write if missing AND the Venice env vars are set.
# Format follows upstream cli-config.yaml.example shape (model.* block).
# The api_key is written inline (chmod 600); rotation requires deleting config.yaml.
if [ ! -f "$HERMES_HOME/config.yaml" ] && [ -n "${OPENAI_API_KEY:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
    BASE_URL="${OPENAI_BASE_URL:-https://api.venice.ai/api/v1}"
    cat > "$HERMES_HOME/config.yaml" <<EOF
model:
  provider: custom
  model: ${HERMES_MODEL}
  base_url: ${BASE_URL}
  api_key: ${OPENAI_API_KEY}
EOF
    chmod 600 "$HERMES_HOME/config.yaml"
fi

# Sherwood: hermes user's HOME is /opt/data per upstream Dockerfile
# (`useradd -u 10000 -m -d /opt/data hermes`), so ~/.sherwood = /opt/data/.sherwood
# which lives on the persistent volume.
if [ -n "${AGENT_PRIVATE_KEY:-}" ] && [ ! -f "$HERMES_HOME/.sherwood/config.json" ] && command -v sherwood >/dev/null 2>&1; then
    sherwood config set \
        --private-key "$AGENT_PRIVATE_KEY" \
        --rpc "${BASE_RPC_URL:-https://base-rpc.publicnode.com}" \
        >/dev/null 2>&1 || echo "warning: 'sherwood config set' failed; check CLI surface"
fi

exec /opt/hermes/docker/entrypoint.sh "$@"
