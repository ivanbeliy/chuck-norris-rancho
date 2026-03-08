#!/bin/bash
# Створити snapshot дроплету для бекапу
# Запускати: bash scripts/snapshot.sh
set -euo pipefail

if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^\s*$' | xargs)
fi

DROPLET_ID=$(doctl compute droplet list --tag-name whiteclaw --format ID --no-header | head -1)
SNAPSHOT_NAME="whiteclaw-$(date +%Y%m%d-%H%M)"

echo "=== Creating snapshot: $SNAPSHOT_NAME ==="
doctl compute droplet-action snapshot "$DROPLET_ID" --snapshot-name "$SNAPSHOT_NAME" --wait

echo "Done! Snapshots:"
doctl compute snapshot list --resource droplet | grep whiteclaw
