# WhiteClaw

Personal AI agent orchestrator powered by [NanoClaw](https://github.com/qwibitai/nanoclaw), deployed on DigitalOcean, controlled via WhatsApp.

## Architecture

```
Windows Workstation                    DigitalOcean VM (Ubuntu 24.04)
+------------------+                   +----------------------------------+
| WhiteClaw repo   |   SSH/doctl       | NanoClaw (Node.js)               |
| scripts/         | ───────────────── | ├── WhatsApp channel (Baileys)   |
| config/          |                   | ├── SQLite (messages/tasks)      |
|                  |                   | ├── Docker containers            |
| shared/          |   Syncthing       | │   └── Claude Agent SDK         |
| ├── inbox/       | ◄═══════════════► | └── systemd service              |
| ├── outbox/      |   (port 22000)    |                                  |
| └── projects/    |                   | /root/shared/ (synced)           |
+------------------+                   +----------------------------------+
```

## Quick Start

1. Copy `.env.example` to `.env` and fill in values
2. Run `bash infra/provision-droplet.sh` to create the VM
3. Run `ssh whiteclaw < infra/setup-vm.sh` to configure the VM
4. SSH into VM, clone NanoClaw, run `/setup`
5. Pair Syncthing between Windows and VM
6. Send a WhatsApp message to test

## Scripts

| Script | Description |
|--------|-------------|
| `infra/provision-droplet.sh` | Create DigitalOcean droplet |
| `infra/firewall.sh` | Configure firewall rules |
| `infra/setup-vm.sh` | Install all VM dependencies |
| `scripts/deploy.sh` | Redeploy NanoClaw |
| `scripts/logs.sh` | Tail NanoClaw logs |
| `scripts/restart.sh` | Restart NanoClaw service |
| `scripts/status.sh` | Full system status |

## File Exchange

- `shared/inbox/` — put files here for the agent to process
- `shared/outbox/` — agent puts completed files here
- `shared/projects/` — shared project directories
