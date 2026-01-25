#!/bin/bash
set -e

echo "=== Clawdbot Entrypoint ==="
echo "Date: $(date)"

# Clawdbot data directory (will be a mounted volume)
CLAWDBOT_DIR="/root/.clawdbot"

# Initial config copied during build (to a different location)
CLAWDBOT_INIT="/app/clawdbot-init"

# Debug: show what we have
echo "Checking init directory..."
ls -la "$CLAWDBOT_INIT/" 2>/dev/null || echo "Init directory not found!"

echo "Checking clawdbot directory..."
ls -la "$CLAWDBOT_DIR/" 2>/dev/null || echo "Clawdbot directory empty or not found"

# Ensure clawdbot directory exists
mkdir -p "$CLAWDBOT_DIR"

# If the volume is empty (no clawdbot.json), copy initial config
if [ ! -f "$CLAWDBOT_DIR/clawdbot.json" ]; then
    echo "No config found, initializing from build artifacts..."

    if [ -d "$CLAWDBOT_INIT" ] && [ -f "$CLAWDBOT_INIT/clawdbot.json" ]; then
        cp -rv "$CLAWDBOT_INIT/"* "$CLAWDBOT_DIR/"
        echo "Config initialized successfully."
    else
        echo "ERROR: Init directory or config not found!"
        echo "Contents of /app:"
        ls -la /app/
        exit 1
    fi
else
    echo "Existing clawdbot config found, using it."
fi

# Verify config exists
echo "Final config check:"
ls -la "$CLAWDBOT_DIR/"

if [ ! -f "$CLAWDBOT_DIR/clawdbot.json" ]; then
    echo "ERROR: clawdbot.json still not found after initialization!"
    exit 1
fi

# Ensure workspace exists
mkdir -p /app/workspace

echo "=== Starting Gateway ==="
# Start the gateway
exec npx clawdbot gateway --port 18789
