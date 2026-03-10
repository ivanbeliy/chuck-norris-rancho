# WhiteClaw Runbook

## Підключення

SSH працює на порту **443** (порт 22 може блокуватися ISP):
```bash
ssh whiteclaw
```

Конфіг SSH (`~/.ssh/config`) має містити `Port 443`.

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

### SSH connection timeout
ISP може блокувати порт 22. VM слухає SSH на двох портах:
- Порт 22 (стандартний)
- Порт 443 (fallback, рекомендований)

Якщо обидва не працюють — використати [DigitalOcean Console](https://cloud.digitalocean.com/droplets).

### Agent not responding
1. Check service: `ssh whiteclaw "systemctl status nanoclaw"`
2. Check logs: `bash scripts/logs.sh error`
3. Restart: `bash scripts/restart.sh`

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
ssh whiteclaw "apt update && DEBIAN_FRONTEND=noninteractive apt upgrade -y"
```

### Lock down Syncthing GUI (after pairing)
```bash
ssh whiteclaw "sed -i 's|0.0.0.0:8384|127.0.0.1:8384|' /root/.config/syncthing/config.xml && systemctl restart syncthing@root"
```
Access via SSH tunnel: `ssh -L 8384:localhost:8384 whiteclaw`

## SSH Tunnel Cheat Sheet

```bash
# Syncthing GUI
ssh -L 8384:localhost:8384 whiteclaw

# Interactive session with tmux
ssh whiteclaw -t "tmux attach || tmux new"
```
