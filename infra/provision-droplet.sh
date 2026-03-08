#!/bin/bash
# Створення дроплету DigitalOcean для WhiteClaw
# Запускати з Windows (Git Bash): bash infra/provision-droplet.sh
set -euo pipefail

# Завантажити змінні з .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^\s*$' | xargs)
fi

DROPLET_NAME="whiteclaw"
REGION="${DO_REGION:-fra1}"        # Frankfurt за замовчуванням (найближчий до UA)
SIZE="s-4vcpu-8gb"                # 4 vCPU, 8GB RAM, 160GB SSD (~$48/month)
IMAGE="ubuntu-24-04-x64"

if [ -z "${DO_API_TOKEN:-}" ]; then
  echo "ERROR: DO_API_TOKEN not set. Add it to .env"
  exit 1
fi

if [ -z "${DO_SSH_KEY_FINGERPRINT:-}" ]; then
  echo "ERROR: DO_SSH_KEY_FINGERPRINT not set."
  echo ""
  echo "Available SSH keys:"
  doctl compute ssh-key list
  echo ""
  echo "Add the fingerprint to .env as DO_SSH_KEY_FINGERPRINT"
  exit 1
fi

echo "=== Creating droplet: $DROPLET_NAME ==="
echo "Region: $REGION"
echo "Size: $SIZE"
echo "Image: $IMAGE"
echo ""

doctl compute droplet create "$DROPLET_NAME" \
  --region "$REGION" \
  --size "$SIZE" \
  --image "$IMAGE" \
  --ssh-keys "$DO_SSH_KEY_FINGERPRINT" \
  --tag-name "whiteclaw" \
  --wait

# Отримати IP
DROPLET_IP=$(doctl compute droplet list --tag-name whiteclaw \
  --format PublicIPv4 --no-header | head -1)

echo ""
echo "=== Droplet created! ==="
echo "IP: $DROPLET_IP"
echo ""
echo "Next steps:"
echo "1. Add to .env:  DO_DROPLET_IP=$DROPLET_IP"
echo "2. Add to ~/.ssh/config:"
echo "   Host whiteclaw"
echo "       HostName $DROPLET_IP"
echo "       User root"
echo "       IdentityFile ~/.ssh/whiteclaw_ed25519"
echo "       ServerAliveInterval 60"
echo "3. Test: ssh whiteclaw"
echo "4. Setup firewall: bash infra/firewall.sh"
echo "5. Setup VM: ssh whiteclaw < infra/setup-vm.sh"
