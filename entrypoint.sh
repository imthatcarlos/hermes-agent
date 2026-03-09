#!/bin/bash

echo "=== OpenClaw Entrypoint ==="
echo "Date: $(date)"

OPENCLAW_DIR="/root/.openclaw"
OPENCLAW_INIT="/app/openclaw-init"

mkdir -p "$OPENCLAW_DIR"

# Always overwrite config from build artifacts (source of truth is the repo)
if [ -d "$OPENCLAW_INIT" ] && [ -f "$OPENCLAW_INIT/openclaw.json" ]; then
    echo "Syncing config from build artifacts..."
    cp -rv "$OPENCLAW_INIT/"* "$OPENCLAW_DIR/"
else
    echo "ERROR: Init directory or config not found!"
    exit 1
fi

if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "ERROR: openclaw.json not found!"
    exit 1
fi

mkdir -p /app/workspace

# === Start Mission Control Dashboard ===
MC_DATA_DIR="$OPENCLAW_DIR/mission-control-data"
mkdir -p "$MC_DATA_DIR"

echo "=== Starting Mission Control on port 3001 ==="
cd /app/mission-control

# Mission Control env vars
export PORT=3001
export AUTH_USER="carlos"
export AUTH_PASS="${MC_AUTH_PASS:-zUiP8aXDEvZP6jQGbnQ3Kk9OmvsgHR}"
export API_KEY="${MC_API_KEY:-4d49c7dde20ce1cab590221f144225d356a68af528cc0b2106ea99f0a1fba3f1}"
export AUTH_SECRET="${MC_AUTH_SECRET:-6561c6a51a6029851bf9b48a9178cebe}"
export MC_COOKIE_SECURE=true
export MC_COOKIE_SAMESITE=strict
export MC_ALLOWED_HOSTS="${MC_ALLOWED_HOSTS:-localhost,127.0.0.1}"
export OPENCLAW_HOME="/root"
export OPENCLAW_GATEWAY_HOST=127.0.0.1
export OPENCLAW_GATEWAY_PORT=18789
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
# Frontend WS connects via server-side proxy, not directly to gateway
export NEXT_PUBLIC_GATEWAY_HOST=""
export NEXT_PUBLIC_GATEWAY_PORT=""
export NEXT_PUBLIC_GATEWAY_URL=""
export MISSION_CONTROL_DATA_DIR="$MC_DATA_DIR"
export MISSION_CONTROL_DB_PATH="$MC_DATA_DIR/mission-control.db"
export MISSION_CONTROL_TOKENS_PATH="$MC_DATA_DIR/mission-control-tokens.json"

# Start MC in background, log to file
pnpm start > /tmp/mission-control.log 2>&1 &
MC_PID=$!
echo "Mission Control started (PID: $MC_PID)"

cd /app/workspace

# === Clear stale Telegram polling before starting gateway ===
# Railway rolling deploys can leave the old container polling, causing 409 conflicts.
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo "Clearing stale Telegram polling state..."
    curl -sf "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=false" || true
    echo "Waiting 10s for old polling connections to expire..."
    sleep 10
fi

# === Start OpenClaw Gateway with crash recovery ===
FAILURES=0
MAX_FAILURES=3

while true; do
    FAILURES=$((FAILURES+1))

    # Re-initialize config if it was wiped (openclaw doctor bug #40410/#10688)
    if [ ! -s "$OPENCLAW_DIR/openclaw.json" ]; then
        echo "WARNING: openclaw.json missing or empty, restoring from init..."
        cp -v "$OPENCLAW_INIT/openclaw.json" "$OPENCLAW_DIR/openclaw.json"
    fi

    # Kill any orphaned gateway processes from previous attempts
    if [ $FAILURES -gt 1 ]; then
        echo "Cleaning up orphaned processes..."
        pkill -f "openclaw-gateway" 2>/dev/null || true
        pkill -f "openclaw" 2>/dev/null || true
        sleep 5
    fi

    echo "=== Starting Gateway (attempt $FAILURES) ==="
    npx openclaw gateway --port 18789 --allow-unconfigured
    EXIT_CODE=$?
    echo "Gateway exited with code $EXIT_CODE at $(date)"

    if [ $FAILURES -ge $MAX_FAILURES ]; then
        echo "Gateway failed $FAILURES times. Staying alive for SSH debugging..."
        sleep infinity
    fi

    echo "Restarting in 5s..."
    sleep 5
done
