#!/bin/bash
set -e

echo "=== OpenClaw Entrypoint ==="
echo "Date: $(date)"

# OpenClaw data directory (will be a mounted volume)
OPENCLAW_DIR="/root/.openclaw"

# Initial config copied during build (to a different location)
OPENCLAW_INIT="/app/openclaw-init"

# Debug: show what we have
echo "Checking init directory..."
ls -la "$OPENCLAW_INIT/" 2>/dev/null || echo "Init directory not found!"

echo "Checking openclaw directory..."
ls -la "$OPENCLAW_DIR/" 2>/dev/null || echo "OpenClaw directory empty or not found"

# Ensure openclaw directory exists
mkdir -p "$OPENCLAW_DIR"

# Run doctor to migrate from clawdbot if needed (handles .clawdbot → .openclaw)
echo "Running openclaw doctor for migration..."
openclaw doctor --yes 2>/dev/null || true

# If the volume is empty (no openclaw.json), copy initial config
if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "No config found, initializing from build artifacts..."

    if [ -d "$OPENCLAW_INIT" ] && [ -f "$OPENCLAW_INIT/clawdbot.json" ]; then
        cp -rv "$OPENCLAW_INIT/"* "$OPENCLAW_DIR/"
        # Rename config file if it was copied as clawdbot.json
        if [ -f "$OPENCLAW_DIR/clawdbot.json" ] && [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
            mv "$OPENCLAW_DIR/clawdbot.json" "$OPENCLAW_DIR/openclaw.json"
        fi
        echo "Config initialized successfully."
    else
        echo "ERROR: Init directory or config not found!"
        echo "Contents of /app:"
        ls -la /app/
        exit 1
    fi
else
    echo "Existing openclaw config found, using it."
fi

# Verify config exists
echo "Final config check:"
ls -la "$OPENCLAW_DIR/"

if [ ! -f "$OPENCLAW_DIR/openclaw.json" ]; then
    echo "ERROR: openclaw.json still not found after initialization!"
    exit 1
fi

# Ensure workspace exists
mkdir -p /app/workspace

echo "=== Starting Gateway ==="
# Start the gateway
exec npx openclaw gateway --port 18789
