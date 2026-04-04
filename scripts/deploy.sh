#!/bin/bash
# Deploy Relay to Mac Mini
# Run from Windows: bash scripts/deploy.sh
set -euo pipefail

echo "=== Deploying Relay ==="

# Upload relay source (excluding runtime files)
echo "Uploading relay source..."
scp -r relay/package.json relay/tsconfig.json relay/relay.env.example relay/CLAUDE.md rancho:~/relay/
scp -r relay/src rancho:~/relay/
scp -r relay/templates rancho:~/relay/

# Upload infrastructure
scp infra/relay.plist rancho:~/relay/

ssh rancho << 'REMOTE'
  set -euo pipefail
  cd ~/relay

  echo "Installing dependencies..."
  npm install

  echo "Building..."
  npm run build

  mkdir -p logs

  # Install plist if not already in LaunchAgents
  PLIST_SRC=~/relay/relay.plist
  PLIST_DST=~/Library/LaunchAgents/com.rancho.relay.plist
  if [ -f "$PLIST_SRC" ]; then
    cp "$PLIST_SRC" "$PLIST_DST"
  fi

  echo "Restarting service..."
  launchctl kickstart -k "gui/$(id -u)/com.rancho.relay" 2>/dev/null || \
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
  sleep 2
  launchctl print "gui/$(id -u)/com.rancho.relay" 2>&1 | head -15

  echo ""
  echo "=== Deploy complete ==="
REMOTE
