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

### Reverse proxy notes

This app keeps some HTTP connections open (receiver wait / downloads). If you're deploying behind a reverse proxy or CDN, configure its read/idle timeouts accordingly. The server itself disables Bun's idle timeout (`idleTimeout: 0` in [server.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/server.ts)).

## Docs (dev)

- [docs/implementation.md](./docs/implementation.md)
