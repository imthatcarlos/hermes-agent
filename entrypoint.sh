#!/bin/bash
set -e

echo "=== OpenClaw Entrypoint ==="
echo "Date: $(date)"

OPENCLAW_DIR="/root/.openclaw"
OPENCLAW_INIT="/app/openclaw-init"

mkdir -p "$OPENCLAW_DIR"

# If no config, copy from build artifacts
if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "No config found, initializing from build artifacts..."
    if [ -d "$OPENCLAW_INIT" ] && [ -f "$OPENCLAW_INIT/openclaw.json" ]; then
        cp -rv "$OPENCLAW_INIT/"* "$OPENCLAW_DIR/"
    else
        echo "ERROR: Init directory or config not found!"
        exit 1
    fi
else
    echo "Existing openclaw config found."
fi

if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "ERROR: openclaw.json not found!"
    exit 1
fi

mkdir -p /app/workspace

echo "=== Starting Gateway ==="
exec npx openclaw gateway --port 18789
