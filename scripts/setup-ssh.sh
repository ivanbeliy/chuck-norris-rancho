#!/bin/bash
# Створити SSH-ключ та налаштувати конфіг для VM
# Запускати: bash scripts/setup-ssh.sh <DROPLET_IP>
set -euo pipefail

DROPLET_IP="${1:-}"

if [ -z "$DROPLET_IP" ]; then
  echo "Usage: bash scripts/setup-ssh.sh <DROPLET_IP>"
  exit 1
fi

KEY_FILE="$HOME/.ssh/whiteclaw_ed25519"

# Створити SSH-ключ якщо не існує
if [ ! -f "$KEY_FILE" ]; then
  echo "=== Generating SSH key ==="
  ssh-keygen -t ed25519 -C "whiteclaw-vm" -f "$KEY_FILE" -N ""
  echo ""
  echo "Public key (add to DigitalOcean → Settings → Security → SSH Keys):"
  cat "${KEY_FILE}.pub"
  echo ""
fi

# Додати конфіг
SSH_CONFIG="$HOME/.ssh/config"
if grep -q "Host whiteclaw" "$SSH_CONFIG" 2>/dev/null; then
  echo "SSH config entry 'whiteclaw' already exists. Updating..."
  # Видалити старий запис (до наступного Host або кінця файлу)
  sed -i '/^Host whiteclaw$/,/^Host /{ /^Host whiteclaw$/d; /^Host /!d; }' "$SSH_CONFIG"
fi

cat >> "$SSH_CONFIG" << EOF

Host whiteclaw
    HostName $DROPLET_IP
    Port 443
    User root
    IdentityFile $KEY_FILE
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF

echo "=== SSH config updated ==="
echo "Test: ssh whiteclaw"
