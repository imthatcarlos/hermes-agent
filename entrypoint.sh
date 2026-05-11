#!/bin/bash

echo "=== Hermes Agent Entrypoint ==="
echo "Date: $(date)"

# Make `hermes` resolvable regardless of /usr/local/bin symlink state.
export PATH="/opt/hermes/.venv/bin:$PATH"

mkdir -p /app/workspace

# Symlink Sherwood Fund into the volume-mounted ~/.hermes (anything baked into
# /root/.hermes during the Docker build is shadowed by the runtime volume, so
# the plugin lives at /opt/hermes-fund/ and we link it in on each start).
mkdir -p /root/.hermes/plugins /root/.hermes/dashboard-themes
ln -sfn /opt/hermes-fund/plugins/hermes-fund /root/.hermes/plugins/hermes-fund
ln -sf  /opt/hermes-fund/dashboard-themes/sherwood.yaml /root/.hermes/dashboard-themes/sherwood.yaml

# Start the Hermes dashboard behind a Caddy basic-auth reverse proxy.
#
#   - Hermes dashboard:  binds 127.0.0.1:9119 (its safe default — no creds exposed)
#   - Caddy:             binds 0.0.0.0:9118 with basic auth, proxies → 127.0.0.1:9119
#   - Railway:           tcpProxy on 9118 → public URL
#
# Required Railway env var:
#   DASHBOARD_PASSWORD   (mandatory; if unset, dashboard + Caddy are skipped)
# Optional:
#   DASHBOARD_USERNAME   (defaults to "admin")
DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-admin}"
if [ -z "${DASHBOARD_PASSWORD:-}" ]; then
    echo "Dashboard skipped: set DASHBOARD_PASSWORD on Railway to enable the Sherwood Fund tab."
else
    DASHBOARD_HASH=$(caddy hash-password --plaintext "$DASHBOARD_PASSWORD")
    cat > /tmp/Caddyfile <<EOF
{
    auto_https off
    admin off
}
:9118 {
    basic_auth {
        $DASHBOARD_USERNAME $DASHBOARD_HASH
    }
    reverse_proxy 127.0.0.1:9119 {
        # Hermes dashboard rejects requests whose Host header doesn't match
        # its bind address. Rewrite to match what Hermes is listening on.
        header_up Host 127.0.0.1:9119
    }
}
EOF
    # Prefix child output so Railway logs show which process said what.
    ( caddy run --config /tmp/Caddyfile --adapter caddyfile 2>&1 |
        sed -u 's/^/[caddy] /' ) &
    CADDY_PID=$!

    ( hermes dashboard --host 127.0.0.1 --port 9119 2>&1 |
        sed -u 's/^/[dashboard] /' ) &
    DASHBOARD_PID=$!

    sleep 4
    if kill -0 "$CADDY_PID" 2>/dev/null && kill -0 "$DASHBOARD_PID" 2>/dev/null; then
        echo "Dashboard up at :9118 (basic auth user: $DASHBOARD_USERNAME)"
    else
        echo "WARNING: Caddy or dashboard failed to start. caddy_alive=$(kill -0 $CADDY_PID 2>/dev/null && echo yes || echo no) dashboard_alive=$(kill -0 $DASHBOARD_PID 2>/dev/null && echo yes || echo no). Gateway will continue."
    fi
fi

cd /app/workspace

# === Start Hermes Gateway with crash recovery ===
FAILURES=0
MAX_FAILURES=3

while true; do
    FAILURES=$((FAILURES+1))

    # Kill orphaned gateway processes only (preserve the dashboard)
    if [ $FAILURES -gt 1 ]; then
        echo "Cleaning up orphaned gateway processes..."
        pkill -f "hermes gateway" 2>/dev/null || true
        sleep 5
    fi

    echo "=== Starting Gateway (attempt $FAILURES) ==="
    hermes gateway run
    EXIT_CODE=$?
    echo "Gateway exited with code $EXIT_CODE at $(date)"

    if [ $FAILURES -ge $MAX_FAILURES ]; then
        echo "Gateway failed $FAILURES times. Staying alive for SSH debugging..."
        sleep infinity
    fi

    echo "Restarting in 5s..."
    sleep 5
done
