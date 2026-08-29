#!/usr/bin/env bash
# Deploy Vitrina from the repo to its runtime location and (re)start the service.
# Idempotent: safe to re-run after any code change.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$HOME/vitrina"
UID_N="$(id -u)"

mkdir -p "$RUNTIME/data/store" "$RUNTIME/logs"

# --delete keeps the runtime a clean mirror of the repo; data/ and logs/ are ours.
rsync -a --delete \
  --exclude 'data/' --exclude 'logs/' --exclude 'node_modules/' \
  "$REPO/vitrina/" "$RUNTIME/"

# CLI on PATH for every Chuck session
ln -sf "$RUNTIME/bin/vitrina" /opt/homebrew/bin/vitrina
mkdir -p "$HOME/bin" && ln -sf "$RUNTIME/bin/vitrina" "$HOME/bin/vitrina"

# launchd: the service loads its secrets from ~/.config/rancho/vitrina.env,
# so the plist itself carries no token.
cp "$REPO/infra/vitrina.plist" "$HOME/Library/LaunchAgents/com.rancho.vitrina.plist"

# bootstrap fails with EIO if the label is already loaded, and bootout is async —
# so: load it if absent, then kickstart -k to pick up new code either way.
if ! launchctl print "gui/$UID_N/com.rancho.vitrina" >/dev/null 2>&1; then
  launchctl bootstrap "gui/$UID_N" "$HOME/Library/LaunchAgents/com.rancho.vitrina.plist"
fi
launchctl kickstart -k "gui/$UID_N/com.rancho.vitrina"

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${VITRINA_PORT:-4477}/healthz" >/dev/null 2>&1 \
  && curl -fsS "http://127.0.0.1:${VITRINA_ADMIN_PORT:-4478}/healthz" >/dev/null 2>&1; then
    echo "vitrina: public + admin ok"
    echo "deployed to $RUNTIME"
    exit 0
  fi
  sleep 0.5
done
echo "vitrina: service did not come up — see $RUNTIME/logs/vitrina.err.log" >&2
exit 1
