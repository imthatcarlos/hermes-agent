#!/bin/bash
set -e

echo "=== OpenClaw Entrypoint ==="
echo "Date: $(date)"

# OpenClaw data directory (will be a mounted volume)
OPENCLAW_DIR="/root/.openclaw"
CLAWDBOT_DIR="/root/.clawdbot"

# Initial config copied during build (to a different location)
OPENCLAW_INIT="/app/openclaw-init"

# Migration: if .clawdbot exists but .openclaw doesn't, run doctor to migrate
if [ -d "$CLAWDBOT_DIR" ] && [ ! -d "$OPENCLAW_DIR" ]; then
    echo "Found .clawdbot but no .openclaw - running migration..."
    openclaw doctor --yes || true
fi

# Ensure openclaw directory exists
mkdir -p "$OPENCLAW_DIR"

# If the volume is empty (no openclaw.json), copy initial config
if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "No config found, initializing from build artifacts..."

    if [ -d "$OPENCLAW_INIT" ] && [ -f "$OPENCLAW_INIT/openclaw.json" ]; then
        cp -rv "$OPENCLAW_INIT/"* "$OPENCLAW_DIR/"
        echo "Config initialized successfully."
    else
        echo "ERROR: Init directory or config not found!"
        ls -la /app/
        exit 1
    fi
else
    echo "Existing openclaw config found."
fi

# Verify config exists
if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "ERROR: openclaw.json not found!"
    exit 1
fi

# Ensure workspace exists
mkdir -p /app/workspace

echo "=== Starting Gateway ==="
exec npx openclaw gateway --port 18789
