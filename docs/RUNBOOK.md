# WhiteClaw Runbook

## Daily Operations

### Check status
```bash
bash scripts/status.sh
```

### View logs
```bash
bash scripts/logs.sh        # main logs
bash scripts/logs.sh error   # error logs only
```

### Restart NanoClaw
```bash
bash scripts/restart.sh
```

## Troubleshooting

### Agent not responding to WhatsApp messages
1. Check service: `ssh whiteclaw "systemctl status nanoclaw"`
2. Check logs: `bash scripts/logs.sh error`
3. Verify WhatsApp auth: `ssh whiteclaw "ls -la /root/nanoclaw/store/auth/creds.json"`
4. Re-auth if needed: stop service, `cd /root/nanoclaw && npm run auth`, restart

### WhatsApp disconnected
WhatsApp may disconnect if the session is used elsewhere.
1. On phone: WhatsApp → Settings → Linked Devices → check if WhiteClaw is linked
2. If unlinked: `ssh whiteclaw` → stop NanoClaw → `cd /root/nanoclaw && rm -rf store/auth && npm run auth`
3. Re-pair with pairing code

### Container OOM / slow
1. Check running containers: `ssh whiteclaw "docker ps"`
2. Check memory: `ssh whiteclaw "free -h"`
3. Kill stuck containers: `ssh whiteclaw "docker kill \$(docker ps -q)"`
4. Reduce concurrency: edit `/root/nanoclaw/.env` → `MAX_CONCURRENT_CONTAINERS=1`

### Syncthing not syncing
1. Check service: `ssh whiteclaw "systemctl status syncthing@root"`
2. Check GUI via tunnel: `ssh -L 8384:localhost:8384 whiteclaw` → open `http://localhost:8384`
3. Verify device is connected in Syncthing GUI
4. Check firewall: ports 22000 (TCP/UDP) and 21027 (UDP)

### OAuth token expired
1. SSH into VM: `ssh whiteclaw`
2. `claude setup-token`
3. Update `/root/nanoclaw/.env` with new token
4. `systemctl restart nanoclaw`

## Maintenance

### Update NanoClaw
```bash
bash scripts/deploy.sh
```

### Create backup snapshot
```bash
bash scripts/snapshot.sh
```

### Update VM packages
```bash
ssh whiteclaw "apt update && apt upgrade -y"
```

### Update agent instructions
Edit `config/agent-claude.md` locally, then:
```bash
ssh whiteclaw "cp /root/whiteclaw-config/config/agent-claude.md /root/nanoclaw/groups/main/CLAUDE.md"
bash scripts/restart.sh
```

## SSH Tunnel Cheat Sheet

```bash
# Syncthing GUI
ssh -L 8384:localhost:8384 whiteclaw

# Interactive session with tmux
ssh whiteclaw -t "tmux attach || tmux new"
```
