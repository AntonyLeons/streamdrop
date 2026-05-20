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

### Self-hosting

If you don't trust the public server or want full control, StreamDrop is easy to self-host. All encryption happens client-side, but self-hosting gives you:
- Full control over connection metadata
- No reliance on third-party infrastructure
- Full auditability

**Star the repo** if you find this useful! It helps others discover StreamDrop.

### Reverse proxy examples

StreamDrop keeps long-lived HTTP connections open (for receiver waiting and streaming downloads). Configure your reverse proxy with generous read/idle timeouts. The server itself disables Bun's idle timeout (`idleTimeout: 0` in [server.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/server.ts)).

**Nginx:**
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Critical for long polling / streaming
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

**Caddy (Caddyfile):**
```
your-domain.com {
    reverse_proxy localhost:3000 {
        transport http {
            response_header_timeout 24h
        }
    }
}
```

**Traefik (docker-compose labels):**
```yaml
labels:
  - "traefik.http.routers.streamdrop.rule=Host(`your-domain.com`)"
  - "traefik.http.services.streamdrop.loadbalancer.server.port=3000"
  # Increase idle timeout for long-running connections
  - "traefik.http.middlewares.streamdrop-timeout.plugin.traefik-plugin-response-modifier.responseHeaderTimeout=86400"
```

**Cloudflare:**
If using Cloudflare as your CDN/proxy, be aware that Cloudflare has a default 100-second timeout. For best experience with large file transfers:
- Use **Cloudflare Tunnel** with `cloudflared` (no hard timeout)
- Or configure a longer timeout via Page Rules → Origin Error Page Pass Thru
- Or use **Argo Tunnel** for uninterrupted streaming

## Docs (dev)

- [docs/implementation.md](./docs/implementation.md)

## iOS / Safari Compatibility

StreamDrop includes full fallback support for iOS and Safari. While Apple's WebKit engine does not currently support `ReadableStream` in `fetch()` bodies, StreamDrop automatically detects iOS and Safari and falls back to a highly optimized `XMLHttpRequest` chunking implementation. It is fully functional on all platforms!

## Support the project

If you find StreamDrop useful, consider:

- **Starring the repo** to help others discover it
- Supporting my open-source work:

<p>
  <a href="https://www.buymeacoffee.com/leons">
    <img align="left" src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" height="50" width="210" alt="leons" />
  </a>
  <a href="https://ko-fi.com/leonsdev">
    <img align="left" src="https://cdn.ko-fi.com/cdn/kofi3.png?v=3" height="50" width="210" alt="leonsdev" />
  </a>
</p>
<br /><br />
