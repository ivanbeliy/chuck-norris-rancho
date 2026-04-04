#!/bin/bash
# Налаштувати SSH-конфіг для підключення до WhiteClaw
# Використання:
#   DO VM:   bash scripts/setup-ssh.sh do <DROPLET_IP>
#   Mac:     bash scripts/setup-ssh.sh mac <TAILSCALE_IP>
set -euo pipefail

TARGET="${1:-}"
HOST_IP="${2:-}"

if [ -z "$TARGET" ] || [ -z "$HOST_IP" ]; then
  echo "Usage:"
  echo "  bash scripts/setup-ssh.sh do  <DROPLET_IP>    # DigitalOcean VM"
  echo "  bash scripts/setup-ssh.sh mac <TAILSCALE_IP>   # Mac Mini (Tailscale)"
  exit 1
fi

SSH_CONFIG="$HOME/.ssh/config"
mkdir -p "$HOME/.ssh"
touch "$SSH_CONFIG"

# Видалити старий запис whiteclaw
if grep -q "^Host whiteclaw$" "$SSH_CONFIG" 2>/dev/null; then
  echo "Видаляю старий запис 'whiteclaw'..."
  # Видалити блок від "Host whiteclaw" до наступного "Host " або кінця файлу
  awk '/^Host whiteclaw$/{skip=1; next} /^Host /{skip=0} !skip' "$SSH_CONFIG" > "$SSH_CONFIG.tmp"
  mv "$SSH_CONFIG.tmp" "$SSH_CONFIG"
fi

case "$TARGET" in
  do)
    KEY_FILE="$HOME/.ssh/whiteclaw_ed25519"
    if [ ! -f "$KEY_FILE" ]; then
      echo "=== Generating SSH key ==="
      ssh-keygen -t ed25519 -C "whiteclaw-vm" -f "$KEY_FILE" -N ""
      echo ""
      echo "Public key (add to DigitalOcean → Settings → Security → SSH Keys):"
      cat "${KEY_FILE}.pub"
      echo ""
    fi

    cat >> "$SSH_CONFIG" << EOF

Host whiteclaw
    HostName $HOST_IP
    Port 443
    User root
    IdentityFile $KEY_FILE
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF
    echo "=== SSH config: whiteclaw → DO VM ($HOST_IP:443) ==="
    ;;

  mac)
    cat >> "$SSH_CONFIG" << EOF

Host whiteclaw
    HostName $HOST_IP
    User i.beliy
    ServerAliveInterval 60
    ServerAliveCountMax 3
EOF
    echo "=== SSH config: whiteclaw → Mac Mini ($HOST_IP via Tailscale) ==="
    ;;

  *)
    echo "ERROR: Unknown target '$TARGET'. Use 'do' or 'mac'."
    exit 1
    ;;
esac

echo "Test: ssh whiteclaw"
