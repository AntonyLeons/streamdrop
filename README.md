# StreamDrop

Design + implementation planning docs:

- [spec.md](./spec.md)
- [checklist.md](./checklist.md)
- [tasks.md](./tasks.md)

## Deploy

### Requirements

- Bun (runtime)

## CLI

Build a portable CLI binary:

```bash
bun install
bun run cli:build
./dist/streamdrop --help
```

Send a file:

```bash
./dist/streamdrop send ./myfile.zip --server https://your-host
```

Receive a file:

```bash
./dist/streamdrop receive "<share-url>" --server https://your-host
```

### Run locally

```bash
bun install
bun run dev
```

Open http://localhost:3000.

### Run in production

```bash
bun install --production
PORT=3000 NODE_ENV=production bun run start
```

### Environment variables

- `PORT` (default: `3000`)
- `NODE_ENV` (set to `production` to disable the local startup log)
- `MAX_SESSIONS` (default: `10000`)
- `MAX_RECEIVERS` (default: `1000`)
- `SESSION_TTL_MS` (default: `7200000`)
- `REAPER_INTERVAL_MS` (default: `60000`)

### Reverse proxy notes

This app keeps some HTTP connections open (receiver wait / downloads). If you're deploying behind a reverse proxy or CDN, configure its read/idle timeouts accordingly. The server itself disables Bun's idle timeout (`idleTimeout: 0` in [server.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/server.ts)).
