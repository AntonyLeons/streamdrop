# StreamDrop

<p align="center">
  <img src="public/static/logo-tile.png" alt="StreamDrop" width="360" />
</p>

StreamDrop is a zero-storage, end-to-end encrypted file transfer tool.
Files are encrypted in the sender’s browser and streamed through the server in real time.

## How it works

- Sender opens the web app and selects files
- StreamDrop generates share links (the decryption key stays in the URL fragment after `#`)
- Receiver opens the link and downloads; decryption happens locally in the browser

## Quick start (local)

```bash
bun install
bun run dev
```

Open http://localhost:3000.

## CLI

Build a portable CLI binary:

```bash
bun install
bun run cli:build
./dist/streamdrop --help
```

Send a file:

```bash
./dist/streamdrop send ./myfile.zip
```

Receive a file:

```bash
./dist/streamdrop receive "<share-url>"
```

Release binaries: GitHub Releases include prebuilt CLI binaries for macOS, Linux, and Windows, plus matching `.sha256` checksum files.

## Deploy

### Requirements

- Bun (runtime)
- Docker & Docker Compose (for production with TURN)

### Run in production

```bash
bun install --production
PORT=3000 NODE_ENV=production bun run start
```

### Environment variables

- `PORT` (default: `3000`)
- `NODE_ENV` (set to `production` to disable the local startup log)
- `PUBLIC_ORIGIN` (recommended in production: `https://streamdrop.app`)
- `MAX_SESSIONS` (default: `50000`)
- `MAX_RECEIVERS` (default: `2000`)
- `SESSION_TTL_MS` (default: `86400000`)
- `REAPER_INTERVAL_MS` (default: `60000`)

### TURN server (P2P support)

P2P transfers require a TURN server for users behind symmetric NATs, CGNAT, or restrictive firewalls (~30-40% of users). Without TURN, P2P falls back to relay mode (server-mediated transfer).

#### Docker Compose (recommended)

The included `docker-compose.yml` bundles a Coturn TURN server. Configure these variables:

```bash
# .env file
TURN_SERVER=your-server-ip          # Public IP of your server
TURN_SECRET=your-long-random-secret  # Shared secret (never exposed to browser)
TURN_TTL_HOURS=24                   # TURN credential lifetime (default: 24)
TURN_TOTAL_QUOTA=2000               # Max concurrent TURN allocations (matches MAX_RECEIVERS)
TURN_USER_QUOTA=50                  # Max concurrent allocations per user
TURN_MAX_BPS=100000000    # Max bandwidth per user (default: 100 Mbps)
```

Start everything:

```bash
docker compose up -d
```

**How it works:** The server generates time-limited TURN credentials using HMAC-SHA1. The secret never reaches the browser. Credentials are bound to the session ID and expire automatically.

**Abuse Prevention:**
- **Rate Limiting:** `/config` is limited to 20 requests/minute per IP.
- **Quotas:** Coturn limits are configurable via `TURN_TOTAL_QUOTA` and `TURN_USER_QUOTA`.
- **Expiration:** Credentials expire after `TURN_TTL_HOURS`.
- **Bandwidth:** Set `TURN_MAX_BPS` to limit transfer speed per user (e.g., `100000000` for 100 Mbps).
- **Bandwidth:** Optionally set `--max-bps` in `docker-compose.yml` to limit transfer speed per user.
- **Bandwidth:** Optionally set `--max-bps` in `docker-compose.yml` to limit transfer speed per user.
- **Bandwidth:** Optionally set `--max-bps` in `docker-compose.yml` to limit transfer speed per user.
- **Bandwidth:** Optionally set `--max-bps` in `docker-compose.yml` to limit transfer speed per user.
- **Bandwidth:** Optionally set `--max-bps` in `docker-compose.yml` to limit transfer speed per user.

#### Required firewall ports

| Port | Protocol | Purpose |
|------|----------|---------|
| `3478` | UDP/TCP | TURN/STUN listening port |
| `5349` | TCP | TURN over TLS (optional, for restrictive networks) |
| `49152-65535` | UDP | TURN relay port range |
| `80` | TCP | HTTP (Caddy auto-HTTPS) |
| `443` | TCP | HTTPS (Caddy auto-HTTPS) |

#### Standalone Coturn (no Docker)

```bash
sudo apt install coturn
sudo systemctl enable coturn

# Edit /etc/default/coturn: set TURNSERVER_ENABLED=1
# Edit /etc/turnserver.conf:
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
realm=streamdrop
static-auth-secret=your-secret
total-quota=1000
stale-nonce=600
min-port=49152
max-port=65535

sudo systemctl restart coturn
```

### Reverse proxy notes

This app keeps some HTTP connections open (receiver wait / downloads). If you're deploying behind a reverse proxy or CDN, configure its read/idle timeouts accordingly. The server itself disables Bun's idle timeout (`idleTimeout: 0` in [server.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/server.ts)).

## Docs (dev)

- [docs/implementation.md](./docs/implementation.md)

## iOS / Safari Compatibility

StreamDrop includes full fallback support for iOS and Safari. While Apple's WebKit engine does not currently support `ReadableStream` in `fetch()` bodies, StreamDrop automatically detects iOS and Safari and falls back to a highly optimized `XMLHttpRequest` chunking implementation. It is fully functional on all platforms!
