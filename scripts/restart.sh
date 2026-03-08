#!/bin/bash
# Перезапуск NanoClaw
# Запускати: bash scripts/restart.sh
set -euo pipefail

echo "=== Restarting NanoClaw ==="
ssh whiteclaw "systemctl restart nanoclaw && sleep 2 && systemctl status nanoclaw --no-pager | head -15"
