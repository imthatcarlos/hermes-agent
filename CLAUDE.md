# Clawd Sprite Management

This directory manages a remote Clawd instance running on a Sprite.

## Connection Info

| Item | Value |
|------|-------|
| **Sprite Name** | `clawd` |
| **Organization** | `carlos-beltran-935` |
| **Clawdbot Version** | 2026.1.23-1 |
| **Gateway Port** | 18789 |
| **Workspace** | `/home/sprite/clawd` |

## Quick Commands

### Check Status
```bash
sprite sessions list                    # List active sessions
sprite exec -- ps aux | grep clawdbot   # Check processes
```

### View Gateway Logs
```bash
sprite exec -id <session_id>            # Attach to gateway session (use Ctrl+C to detach)
```

### Start Gateway (if stopped)
```bash
# Gateway must run in foreground mode (no systemd in containers)
sprite exec -tty -- npx clawdbot gateway --port 18789

# Detach with Ctrl+\ to keep it running in background
```

### Run Commands on Sprite
```bash
sprite exec -- <command>                # Run single command
sprite console                          # Interactive shell
```

### Restart Gateway
```bash
# Find and kill existing gateway
sprite exec -- pkill -f clawdbot-gateway

# Start fresh
sprite exec -tty -- npx clawdbot gateway --port 18789
```

## File Locations on Sprite

| Path | Description |
|------|-------------|
| `~/.clawdbot/clawdbot.json` | Main configuration |
| `~/.clawdbot/agents/` | Agent data and sessions |
| `~/.clawdbot/credentials/` | Auth credentials |
| `~/.clawdbot/telegram/` | Telegram plugin data |
| `/home/sprite/clawd/` | Agent workspace |

## Important Notes

1. **No systemd**: Sprites are containers without systemd. Gateway must run in foreground mode via a TTY session.

2. **Session Persistence**: Use `sprite exec -tty` to create persistent sessions. Detach with `Ctrl+\` to keep processes running.

3. **Hibernation**: Sprite hibernates after 30s of inactivity. Processes stop but filesystem persists. Gateway resumes on wake.

4. **Reattaching**: Use `sprite exec -id <session_id>` to reattach to a running session and view logs.

## Channels

- **Telegram**: Enabled (configured in clawdbot.json)

## Custom Skills

### solana-swaps
Location: `~/.clawdbot/skills/solana-swaps/`

Swap tokens on Solana via Jupiter aggregator and check wallet balances.

**Requirements:**
- Solana CLI installed (at `~/.local/share/solana/install/active_release/bin/`)
- `SOLANA_KEYPAIR_PATH` env var pointing to wallet keypair

**Deploy updates:**
```bash
# Copy local skill to Sprite
cat solana-swaps/SKILL.md | sprite exec -- tee ~/.clawdbot/skills/solana-swaps/SKILL.md
cat solana-swaps/scripts/jupiter-swap.mjs | sprite exec -- tee ~/.clawdbot/skills/solana-swaps/scripts/jupiter-swap.mjs
```

**Configure env var in clawdbot.json:**
```json
{
  "skills": {
    "entries": {
      "solana-swaps": {
        "enabled": true,
        "env": {
          "SOLANA_KEYPAIR_PATH": "/home/sprite/.config/solana/id.json"
        }
      }
    }
  }
}
```

## Troubleshooting

### Gateway won't start (lock file error)
```bash
sprite exec -- rm ~/.clawdbot/gateway.*.lock
sprite exec -- pkill -f clawdbot
# Then start gateway fresh
```

### Check gateway is responding
```bash
sprite exec -- curl -s http://localhost:18789/health
```
