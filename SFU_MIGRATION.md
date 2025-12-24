# mediasoup SFU Migration Guide

## What Changed

The streaming architecture has been converted from **peer-to-peer mesh** to **SFU (Selective Forwarding Unit)**.

### Before (Mesh - Bad)
```
Host → Viewer 1 (2.5 Mbps)
Host → Viewer 2 (2.5 Mbps)  
Host → Viewer 3 (2.5 Mbps)
= 7.5 Mbps upload from host (scales linearly with viewers)
```

### After (SFU - Good)
```
Host → Server (2.5 Mbps) → Viewer 1
                        → Viewer 2
                        → Viewer 3
= 2.5 Mbps upload from host (constant regardless of viewers)
```

---

## Environment Variables

### Required for Production

Add these to your `.env` file in `dew-streaming-service`:

```bash
# CRITICAL: Your VPS public IP address
# This is what clients use to connect for WebRTC media
MEDIASOUP_ANNOUNCED_IP=YOUR_VPS_PUBLIC_IP

# Example: MEDIASOUP_ANNOUNCED_IP=123.45.67.89
```

### Optional (with defaults)

```bash
# IP to listen on (default: 0.0.0.0)
MEDIASOUP_LISTEN_IP=0.0.0.0

# UDP/TCP port range for media (default: 10000-10100)
MEDIASOUP_MIN_PORT=10000
MEDIASOUP_MAX_PORT=10100

# Number of workers (default: min(CPU cores, 4))
MEDIASOUP_NUM_WORKERS=2
```

---

## Firewall Configuration

Open these ports on your VPS:

```bash
# HTTP/WebSocket (already open)
8787/tcp

# WebRTC media traffic (NEW - REQUIRED)
10000-10100/udp
10000-10100/tcp
```

### UFW Example
```bash
sudo ufw allow 8787/tcp
sudo ufw allow 10000:10100/udp
sudo ufw allow 10000:10100/tcp
```

### iptables Example
```bash
iptables -A INPUT -p udp --dport 10000:10100 -j ACCEPT
iptables -A INPUT -p tcp --dport 10000:10100 -j ACCEPT
```

---

## Deployment Steps

### 1. Backend (dew-streaming-service)

```bash
cd dew-streaming-service

# Install new dependencies
npm install

# Update .env with your public IP
echo "MEDIASOUP_ANNOUNCED_IP=YOUR_VPS_PUBLIC_IP" >> .env

# Rebuild Docker image
docker-compose build

# Restart service
docker-compose up -d
```

### 2. Frontend (launchpad-moonex-io)

```bash
cd launchpad-moonex-io

# Install mediasoup-client
pnpm install

# Rebuild
pnpm build
```

---

## Docker Compose Notes

The `docker-compose.yml` uses `network_mode: "host"` for mediasoup to work properly with WebRTC. This means:

- The container shares the host's network stack
- Port mappings in `ports:` are ignored (all ports are directly accessible)
- `MEDIASOUP_ANNOUNCED_IP` should be your host's public IP

If you need bridge networking instead, you'll need to configure port forwarding more carefully.

---

## Troubleshooting

### "No mediasoup workers available"
- Check if mediasoup compiled correctly during `npm install`
- Ensure Python 3 and build tools are installed

### Viewers can't connect
- Verify `MEDIASOUP_ANNOUNCED_IP` is set to your public IP
- Check firewall allows UDP 10000-10100
- Check Docker is using host networking

### High latency
- Reduce `MEDIASOUP_NUM_WORKERS` if CPU is overloaded
- Check VPS network performance

---

## Files Changed

### Backend (dew-streaming-service)
- `package.json` - Added mediasoup dependency
- `Dockerfile` - Added build tools for native compilation
- `docker-compose.yml` - Added UDP ports, host networking
- `.env.example` - Added mediasoup config vars
- `src/index.js` - Initialize mediasoup workers
- `src/routes/streaming-ws.js` - New SFU signaling protocol
- `src/sfu/mediasoup-config.js` - NEW: Worker/Router config
- `src/sfu/room-manager.js` - NEW: Room/Producer/Consumer management

### Frontend (launchpad-moonex-io)
- `package.json` - Added mediasoup-client dependency
- `components/live-streaming/stream-manager.tsx` - Rewritten for SFU
