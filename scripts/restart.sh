#!/bin/bash
# Restart Relay
# Run from Windows: bash scripts/restart.sh
set -euo pipefail

echo "=== Restarting Relay ==="
ssh whiteclaw << 'REMOTE'
  if [ "$(uname)" = "Darwin" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.whiteclaw.relay"
    sleep 2
    launchctl print "gui/$(id -u)/com.whiteclaw.relay" 2>&1 | grep -E "state|pid"
  else
    echo "Linux not supported in this version"
  fi
REMOTE
