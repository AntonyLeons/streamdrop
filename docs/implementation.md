## StreamDrop implementation notes

### High level

StreamDrop is an end-to-end encrypted, receiver-first file transfer app.

- The browser generates a random AES-256-GCM key per file.
- The key is never sent to the server.
- The server acts as a “zero-knowledge” relay for ciphertext.
- The receiver connects first and “waits”; the sender streams only when a receiver is present.

The same relay is used for:

- **Web E2EE**: browser → server → browser, encrypted on sender side, decrypted on receiver side.
- **CLI (portable Bun executable)**: CLI sender encrypts, server relays, CLI receiver decrypts.
- **Raw CLI (curl/wget)**: plaintext relay endpoints used by the UI’s curl/wget buttons (not E2EE).

### Identifiers and tokens

Each transfer session has three identifiers:

- `id`: public session id used in page URLs (`GET /:id`).
- `uploadToken`: secret token authorizing uploads (`PUT /upload/:uploadToken/:channelId`).
- `downloadToken`: secret token authorizing downloads (`GET /d/:downloadToken`).

These are generated and tracked in [sessions.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/sessions.ts).

### Web UI flow (E2EE)

#### 1) Session creation

When the upload page loads (`GET /`), the server creates a session and injects its tokens into the page via:

- [renderUploadPage](file:///Users/aleons/Documents/GitHub/streamdrop/src/pages.ts#L3) which sets `window.__STREAMDROP__`
- [createApp](file:///Users/aleons/Documents/GitHub/streamdrop/src/app.ts) which handles `GET /`

The browser may also create additional sessions for “raw CLI” via `POST /session`.

#### 2) Key generation and share URL

When a user selects a file, the browser generates an AES-GCM key and exports it to raw bytes.

The share URL includes the key as a URL fragment:

`https://<host>/<id>#<base64url(keyBytes)>,<urlencoded(filename)>`

Important property: the `#fragment` is never sent to the server in HTTP requests, so the server does not receive the key.

The UI logic for this lives in [upload.js](file:///Users/aleons/Documents/GitHub/streamdrop/public/static/upload.js).

#### 3) Encrypt then wait

The sender encrypts the file before upload.

Encryption is implemented as a streaming transform in [crypto.js](file:///Users/aleons/Documents/GitHub/streamdrop/public/static/crypto.js) (AES-256-GCM).

After encryption finishes, the UI transitions to a receiver-first model:

- It waits for a receiver to be present via `GET /wait-receiver/:id`

#### 4) Receiver connects (download)

The receiver opens the share URL in a browser:

- Server returns the download page via `GET /:id` in [app.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/app.ts)
- The download page JS reads the key fragment and uses `GET /d/:downloadToken` to start the ciphertext stream.

The download JS is in [download.js](file:///Users/aleons/Documents/GitHub/streamdrop/public/static/download.js).

#### 5) Channel claim and upload stream

Each receiver download creates a per-receiver channel on the server:

- `GET /d/:downloadToken` creates a channel, adds it to the session, and returns a ReadableStream of ciphertext.
- The sender then calls `POST /claim/:uploadToken` to claim an unclaimed channel id.
- The sender uploads ciphertext to that channel via `PUT /upload/:uploadToken/:channelId`.

This “claim + channel” design allows multiple receivers sequentially without mixing streams.

Endpoint implementations are in:

- [app.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/app.ts)

#### 6) Decrypt and save

The receiver decrypts the ciphertext stream using the key from the fragment and saves to disk.

In the browser, this uses OPFS (“Origin Private File System”) streaming in [download.js](file:///Users/aleons/Documents/GitHub/streamdrop/public/static/download.js).

### Relay server design

The relay is intentionally “dumb”:

- It does not interpret ciphertext.
- It does not store files.
- It holds only in-memory channels and streams.

Core behaviors:

- `GET /wait-receiver/:id` long-polls until a receiver exists (or times out).
- `GET /d/:downloadToken` creates a channel and streams from that channel to the receiver.
- `POST /claim/:uploadToken` hands the sender a channel to upload into.
- `PUT /upload/:uploadToken/:channelId` pipes sender bytes into the channel controller.

Sessions are garbage-collected by a reaper in [sessions.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/sessions.ts) based on TTL and inactivity.

### Raw CLI endpoints (curl/wget buttons in UI)

The UI offers curl/wget commands for convenience, but they are plaintext and not E2EE.

These commands use:

- `GET /raw/d/:downloadToken`
- `PUT /raw/upload/:uploadToken/:channelId`

Implementation is in [app.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/app.ts).

The UI makes this explicit via the CLI toggle warning in [pages.ts](file:///Users/aleons/Documents/GitHub/streamdrop/src/pages.ts) and controls visibility in [upload.js](file:///Users/aleons/Documents/GitHub/streamdrop/public/static/upload.js).

### Portable CLI (Bun executable)

The CLI is built using Bun’s `--compile` executable bundling:

`bun build cli/index.ts --compile --outfile dist/streamdrop`

Implementation: [cli/index.ts](file:///Users/aleons/Documents/GitHub/streamdrop/cli/index.ts)

#### CLI send

- Creates a session: `POST /session?name=<filename>`
- Generates a random 32-byte AES-GCM key
- Prints a share URL: `/<id>#<key>,<filename>`
- Waits for receivers: `GET /wait-receiver/:id`
- Claims channels: `POST /claim/:uploadToken`
- Encrypts and uploads ciphertext: `PUT /upload/:uploadToken/:channelId`

#### CLI receive

- Parses the share URL (expects `/<id>#<key>,<filename>`)
- Fetches `/<id>` and extracts `downloadToken` from the embedded `window.__STREAMDROP__` JSON
- Downloads ciphertext: `GET /d/:downloadToken`
- Decrypts stream with the key from the fragment
- Writes output to `./<filename>`

Note: parsing `/<id>` HTML to get `downloadToken` is functional but brittle; a dedicated JSON metadata endpoint would be more stable.

### GitHub release builds for CLI

The repository includes a workflow that builds release assets on `release.published`:

- [release-cli.yml](file:///Users/aleons/Documents/GitHub/streamdrop/.github/workflows/release-cli.yml)

It uploads OS-specific archives and `.sha256` checksum files so downstream package managers (Homebrew/Scoop/WinGet/Chocolatey) can reference stable URLs and hashes.

