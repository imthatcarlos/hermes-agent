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

cd /app/workspace

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
