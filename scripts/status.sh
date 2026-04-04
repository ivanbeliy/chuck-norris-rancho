#!/bin/bash
# Full system status for Relay
# Run from Windows: bash scripts/status.sh
set -euo pipefail

echo "=== Relay System Status ==="
echo ""

ssh whiteclaw << 'REMOTE'
  echo "--- System ---"
  uptime
  echo "RAM: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
  df -h / | tail -1
  echo ""

  echo "--- Claude Code ---"
  claude --version 2>/dev/null || echo "not installed"
  echo ""

  echo "--- Relay ---"
  launchctl print "gui/$(id -u)/com.whiteclaw.relay" 2>&1 | grep -E "state|pid" || echo "not loaded"
  echo ""

  echo "--- Projects ---"
  if [ -f ~/relay/relay.db ]; then
    sqlite3 ~/relay/relay.db "SELECT '  ' || p.name || ' [' || COALESCE(s.status, 'no session') || '] — ' || p.project_path FROM projects p LEFT JOIN sessions s ON p.id = s.project_id ORDER BY p.name;" 2>/dev/null || echo "  (db error)"
  else
    echo "  (no database yet)"
  fi
  echo ""

  echo "--- Syncthing ---"
  brew services info syncthing 2>/dev/null | grep -E "Running|Status" || echo "checking..."
  echo ""

  echo "--- Shared Folder ---"
  echo "Files in inbox: $(ls ~/shared/inbox/ 2>/dev/null | wc -l | tr -d ' ')"
  echo "Files in outbox: $(ls ~/shared/outbox/ 2>/dev/null | wc -l | tr -d ' ')"
  echo ""

  echo "--- Recent Logs (last 10 lines) ---"
  tail -10 ~/relay/logs/relay.log 2>/dev/null || echo "No logs yet"
REMOTE
