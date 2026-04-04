#!/bin/bash
# View Relay logs in real-time
# Run from Windows: bash scripts/logs.sh [error]
set -euo pipefail

case "${1:-}" in
  error)
    echo "=== Error logs ==="
    ssh rancho "tail -f ~/relay/logs/relay.error.log"
    ;;
  *)
    echo "=== Relay logs ==="
    ssh rancho "tail -f ~/relay/logs/relay.log"
    ;;
esac
