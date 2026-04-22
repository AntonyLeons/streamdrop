import type { Session } from "./sessions"

export function renderUploadPage(session: Session | null, nonce: string) {
  const config = session
    ? JSON.stringify({ id: session.id, uploadToken: session.uploadToken, downloadToken: session.downloadToken })
    : "{}"

  return htmlPage({
    title: "StreamDrop — Encrypted File Transfer",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div>
              <h1>StreamDrop</h1>
              <p>End-to-end encrypted. Zero storage. Real-time.</p>
            </div>
          </div>
        </header>

        <section class="card">
          <div class="row">
            <div>
              <div class="kicker">Session</div>
              <div class="mono dim" style="font-size:12px;margin-top:3px">${escapeHtml(session?.id ?? "—")}</div>
            </div>
            <a class="link" href="#" id="cli-recipes-link">StreamDrop CLI</a>
          </div>

          <div id="dropzone" class="dropzone" role="button" tabindex="0" aria-label="Drop file to upload">
            <div class="drop-inner">
              <div class="drop-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(124,92,255,.85)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <div class="drop-title">Drop your files here</div>
              <div class="drop-sub">or click to browse · encrypted before upload</div>
            </div>
            <input id="file" class="file" type="file" multiple />
          </div>

          <div class="badge-row">
            <div class="badge"><div class="badge-dot"></div>AES-256-GCM</div>
            <div class="badge"><div class="badge-dot"></div>Zero knowledge relay</div>
            <div class="badge"><div class="badge-dot"></div>Key never leaves browser</div>
          </div>

          <div class="status" style="margin-top:16px">
            <div class="step" data-step="key">
              <div class="dot"></div>
              <div class="label">Key</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="encrypt">
              <div class="dot"></div>
              <div class="label">Encrypt</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="wait">
              <div class="dot"></div>
              <div class="label">Ready</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="stream">
              <div class="dot"></div>
              <div class="label">Stream</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="ready">
              <div class="dot"></div>
              <div class="label">Share</div>
            </div>
          </div>

          <div id="meta" class="meta mono"></div>

          <div id="share" class="share">
            <div class="kicker">Files</div>
            <div class="row" style="margin-top:10px; align-items:center; justify-content:flex-end; gap:12px">
              <div class="dim" style="font-size:13px; display:flex; gap:8px; align-items:center">
                CLI (curl/wget)
                <span class="tooltip">
                  <button class="tooltip-icon" type="button" aria-describedby="cli-warning">i</button>
                  <span id="cli-warning" class="tooltip-bubble" role="tooltip">
                    ⚠️: curl/wget downloads are not E2EE
                  </span>
                </span>
              </div>
              <label class="switch" aria-label="Enable CLI (curl/wget)">
                <input id="cli-toggle" class="switch-input" type="checkbox" />
                <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
              </label>
            </div>
            <div id="share-empty" class="dim" style="font-size:13px;margin-top:10px">Select files above to generate share links.</div>
            <div style="height:10px"></div>
            <div id="shares" class="shares"></div>
            <template id="share-item-template">
              <section class="share-item">
                <div class="share-row">
                  <div class="share-left">
                    <div class="mono share-filename"></div>
                    <div class="mono dim share-state"></div>
                    <div class="share-badges hidden" data-badge="encrypted">
                      <span class="share-badge">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2"></rect>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                        Encrypted
                      </span>
                    </div>
                    <div class="meter meter-small"><div class="bar share-bar"></div></div>
                  </div>
                  <div class="share-actions">
                    <span class="tooltip">
                      <button class="btn btn-small" type="button" data-copy data-copy-kind="curl" aria-describedby="cli-plain-tip">curl</button>
                      <span id="cli-plain-tip" class="tooltip-bubble" role="tooltip">Not E2EE</span>
                    </span>
                    <span class="tooltip">
                      <button class="btn btn-small" type="button" data-copy data-copy-kind="wget" aria-describedby="cli-plain-tip2">wget</button>
                      <span id="cli-plain-tip2" class="tooltip-bubble" role="tooltip">Not E2EE</span>
                    </span>
                    <button class="btn btn-small" type="button" data-action="open-share">Download</button>
                    <button class="btn btn-small" type="button" data-toggle="qr">QR</button>
                    <button class="btn btn-small btn-danger" type="button" data-action="delete">Delete</button>
                  </div>
                </div>
                <div class="share-link-row">
                  <div class="kicker">Share link</div>
                  <div class="copy-row">
                    <input class="input mono share-link" readonly />
                    <button class="btn btn-small" type="button" data-copy>Copy</button>
                  </div>
                </div>
                <div class="share-details hidden">
                  <div class="qr-wrap">
                    <canvas width="200" height="200" class="qr share-qr"></canvas>
                  </div>
                </div>
              </section>
            </template>
          </div>

          <div id="error" class="error hidden"></div>
        </section>
      </main>

      <div id="cli-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="StreamDrop CLI">
        <div class="modal-backdrop" data-action="close-cli-modal"></div>
        <div class="modal-panel">
          <div class="row" style="margin-bottom:14px">
            <div class="kicker">StreamDrop CLI</div>
            <button id="cli-modal-close" class="btn btn-small" type="button" data-action="close-cli-modal">Close</button>
          </div>
          <div id="cli-modal-body"></div>
        </div>
      </div>

      <script nonce="${nonce}">window.__STREAMDROP__=${config}</script>
      <script src="/static/vendor/qrcode.min.js"></script>
      <script type="module" src="/static/upload.js"></script>
    `,
  })
}

export function renderDownloadPage(session: Session, nonce: string) {
  const config = JSON.stringify({ id: session.id, downloadToken: session.downloadToken })

  return htmlPage({
    title: "StreamDrop — Receive File",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div>
              <h1>Receive</h1>
              <p>Decryption happens locally in your browser. The server never sees your file.</p>
            </div>
          </div>
        </header>

        <section class="card">
          <div class="row">
            <div>
              <div class="kicker">Session</div>
              <div class="mono dim" style="font-size:12px;margin-top:3px">${escapeHtml(session.id)}</div>
            </div>
            <a class="link" href="/">New transfer</a>
          </div>

          <div class="badge-row">
            <div class="badge"><div class="badge-dot"></div>AES-256-GCM</div>
            <div class="badge"><div class="badge-dot"></div>Browser-side decrypt</div>
          </div>

          <div class="status" style="margin-top:16px">
            <div class="step" data-step="wait">
              <div class="dot"></div>
              <div class="label">Waiting</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="download">
              <div class="dot"></div>
              <div class="label">Download</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="decrypt">
              <div class="dot"></div>
              <div class="label">Decrypt</div>
            </div>
            <span class="step-arrow">›</span>
            <div class="step" data-step="save">
              <div class="dot"></div>
              <div class="label">Save</div>
            </div>
          </div>

          <div style="display:flex; gap:12px; align-items:center; margin-top:14px;">
            <div class="meter" style="flex:1; margin-top:0;"><div id="bar" class="bar"></div></div>
            <button id="cancel" class="btn hidden" type="button" style="padding: 6px 12px; font-size:11px;">Cancel</button>
          </div>
          <div id="meta" class="meta mono"></div>

          <div class="row space-top">
            <button id="start" class="btn btn-primary" type="button">Start download</button>
            <div id="hint" class="dim" style="font-size:13px">Requires a link with a key fragment.</div>
          </div>

          <div id="error" class="error hidden"></div>
        </section>
      </main>

      <script nonce="${nonce}">window.__STREAMDROP__=${config}</script>
      <script type="module" src="/static/download.js"></script>
    `,
  })
}

export function renderNotFoundPage() {
  return htmlPage({
    title: "StreamDrop — Not Found",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div><h1>StreamDrop</h1><p>Encrypted file transfer.</p></div>
          </div>
        </header>
        <section class="card" style="text-align:center;padding:48px 24px">
          <div style="font-size:48px;margin-bottom:16px">404</div>
          <p style="font-size:16px;color:var(--text)">Session not found.</p>
          <p class="dim" style="margin-top:8px">The sender must keep their upload connection open during the transfer.</p>
          <a class="btn btn-primary link-btn" href="/" style="margin-top:24px;display:inline-block">Start a new transfer</a>
        </section>
      </main>
    `,
  })
}

export function renderServiceUnavailablePage() {
  return htmlPage({
    title: "StreamDrop — Busy",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div><h1>StreamDrop</h1><p>Encrypted file transfer.</p></div>
          </div>
        </header>
        <section class="card" style="text-align:center;padding:48px 24px">
          <div style="font-size:48px;margin-bottom:16px">503</div>
          <p style="font-size:16px;color:var(--text)">Server is at capacity.</p>
          <p class="dim" style="margin-top:8px">Too many active sessions. Please try again in a moment.</p>
          <a class="btn btn-primary link-btn" href="/" style="margin-top:24px;display:inline-block">Try again</a>
        </section>
      </main>
    `,
  })
}

function htmlPage(opts: { title: string; body: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="description" content="Zero-storage, end-to-end encrypted real-time file transfer. No accounts. No cloud." />
    <title>${escapeHtml(opts.title)}</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌊</text></svg>">
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    ${opts.body}
  </body>
</html>`
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
