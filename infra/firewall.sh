#!/bin/bash
# Налаштування файрволу DigitalOcean для WhiteClaw
# Запускати з Windows (Git Bash): bash infra/firewall.sh
set -euo pipefail

if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -v '^\s*$' | xargs)
fi

DROPLET_ID=$(doctl compute droplet list --tag-name whiteclaw --format ID --no-header | head -1)

if [ -z "$DROPLET_ID" ]; then
  echo "ERROR: No droplet found with tag 'whiteclaw'"
  exit 1
fi

echo "=== Creating firewall for droplet $DROPLET_ID ==="

doctl compute firewall create \
  --name "whiteclaw-fw" \
  --droplet-ids "$DROPLET_ID" \
  --inbound-rules \
"protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0 \
protocol:tcp,ports:22000,address:0.0.0.0/0,address:::/0 \
protocol:udp,ports:22000,address:0.0.0.0/0,address:::/0 \
protocol:udp,ports:21027,address:0.0.0.0/0,address:::/0" \
  --outbound-rules \
"protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 \
protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 \
protocol:icmp,address:0.0.0.0/0,address:::/0"

echo ""
echo "=== Firewall created ==="
echo "Inbound: SSH (22), Syncthing (22000 TCP/UDP, 21027 UDP)"
echo "Outbound: All allowed"
