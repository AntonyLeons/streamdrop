import type { Session } from "./sessions"

const LOGO_SRC = "/static/logo.png"

export function renderUploadPage(session: Session | null, nonce: string) {
  const config = session
    ? JSON.stringify({
        id: session.id,
        uploadToken: session.uploadToken,
        downloadToken: session.downloadToken,
        name: session.fileName,
        size: session.fileSize,
      })
    : "{}"

  return htmlPage({
    title: "StreamDrop — Encrypted File Transfer",
    nonce,
    body: `
      <main class="shell">
        <header class="hero">
          <a class="brand link" href="/" style="cursor: pointer; text-decoration: none;">
            <div class="logo"><img class="logo-img" src="${LOGO_SRC}" alt="" /></div>
            <div>
              <h1 style="color: var(--text);">StreamDrop</h1>
              <p style="color: var(--text-muted);">End-to-end encrypted. Zero storage. Real-time.</p>
            </div>
          </a>
          <a href="https://github.com/AntonyLeons/streamdrop" target="_blank" rel="noopener noreferrer" class="icon-btn" aria-label="GitHub Repository">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
          </a>
        </header>

        <section class="card">
          <div class="row">
            <div>
              <div class="kicker">Session</div>
              <div class="mono dim" style="font-size:12px;margin-top:3px">${escapeHtml(session?.id ?? "—")}</div>
            </div>
            <div class="top-controls">
              <button id="btn-cli-modal" class="btn btn-small">StreamDrop CLI</button>
              <button id="theme-toggle" class="icon-btn" type="button" aria-label="Toggle theme">
                <span class="theme-icon theme-icon-sun" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="4"></circle>
                    <path d="M12 2v2"></path>
                    <path d="M12 20v2"></path>
                    <path d="M4.93 4.93l1.41 1.41"></path>
                    <path d="M17.66 17.66l1.41 1.41"></path>
                    <path d="M2 12h2"></path>
                    <path d="M20 12h2"></path>
                    <path d="M6.34 17.66l-1.41 1.41"></path>
                    <path d="M19.07 4.93l-1.41 1.41"></path>
                  </svg>
                </span>
                <span class="theme-icon theme-icon-moon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>
                  </svg>
                </span>
              </button>
            </div>
          </div>

          <div id="dropzone" class="dropzone" role="button" tabindex="0" aria-label="Drop file to upload">
            <div class="drop-inner">
              <div class="drop-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
            <div class="badge mobile-hidden"><div class="badge-dot"></div>Key never leaves browser</div>
          </div>

          <div class="status" style="margin-top:16px">
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
          </div>

          <div id="meta" class="meta mono"></div>

          <div id="sd-files" class="sd-files">
            <div class="kicker">Files</div>
            <div class="row" style="margin-top:10px; align-items:center; justify-content:flex-end; gap:12px">
              <div class="dim" style="font-size:13px; display:flex; gap:8px; align-items:center">
                curl/wget
                <span class="tooltip">
                  <button class="tooltip-icon" type="button" aria-describedby="cli-warning">i</button>
                  <span id="cli-warning" class="tooltip-bubble" role="tooltip">
                    ⚠️: curl/wget downloads are not E2EE use the StreamDrop CLI instead.
                  </span>
                </span>
              </div>
              <label class="switch" aria-label="Enable CLI (curl/wget)">
                <input id="cli-toggle" class="switch-input" type="checkbox" />
                <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
              </label>
            </div>
            <div id="sd-files-empty" class="dim" style="font-size:13px;margin-top:10px">Select files above to generate share links.</div>
            <div style="height:10px"></div>
            <div id="sd-files-list" class="sd-files-list"></div>
            <template id="sd-file-template">
              <section class="sd-file-item">
                <div class="sd-file-row">
                  <div class="sd-file-left">
                    <div class="mono sd-file-name"></div>
                    <div class="mono dim sd-file-state"></div>
                    <div class="sd-file-badges hidden" data-badge="encrypted">
                      <span class="sd-file-badge">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2"></rect>
                          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                        Encrypted
                      </span>
                    </div>
                    <div class="meter meter-small"><div class="bar sd-file-bar"></div></div>
                  </div>
                  <div class="sd-file-actions">
                    <button class="btn btn-small btn-native-share hidden" type="button" data-action="native-share" aria-label="Share" title="Share">
                      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                        <g>
                          <path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"></path>
                        </g>
                      </svg>
                    </button>
                    <span class="tooltip">
                      <button class="btn btn-small" type="button" data-copy data-copy-kind="curl">curl</button>
                      <span class="tooltip-bubble" role="tooltip">Not E2EE</span>
                    </span>
                    <span class="tooltip">
                      <button class="btn btn-small" type="button" data-copy data-copy-kind="wget">wget</button>
                      <span class="tooltip-bubble" role="tooltip">Not E2EE</span>
                    </span>
                    <button class="btn btn-small" type="button" data-copy data-copy-kind="cli">StreamDrop CLI</button>
                    <button class="btn btn-small" type="button" data-action="open-link">Download</button>
                    <button class="btn btn-small" type="button" data-toggle="qr">QR</button>
                    <button class="btn btn-small btn-danger" type="button" data-action="delete">Delete</button>
                  </div>
                </div>
                <div class="sd-file-link-row">
                  <div class="kicker">Share link</div>
                  <div class="copy-row">
                    <input class="input mono sd-file-link" readonly />
                    <button class="btn btn-small" type="button" data-copy>Copy</button>
                  </div>
                </div>
                <div class="sd-file-details hidden">
                  <div class="qr-wrap">
                    <canvas width="200" height="200" class="qr sd-file-qr"></canvas>
                  </div>
                </div>
              </section>
            </template>
          </div>

          <div id="error" class="error hidden"></div>
        </section>
      </main>

      <div id="cli-modal" class="modal hidden">
        <div class="modal-backdrop"></div>
        <div class="modal-content">
          <div class="modal-header">
            <h2 style="margin:0;font-size:18px;">StreamDrop CLI</h2>
            <button class="icon-btn close-modal" aria-label="Close" style="width:24px;height:24px;padding:0;line-height:1;">&times;</button>
          </div>
          <div class="modal-body" style="font-size:14px;color:var(--fg-dim);">
            <p style="margin-top:0;margin-bottom:20px;">Transfer files directly from your terminal with end-to-end encryption.</p>
            
            <div class="tabs" style="display: flex; gap: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--glass-border); overflow-x: auto; white-space: nowrap;">
              <button class="tab-btn active" data-os="npm">npm</button>
              <button class="tab-btn" data-os="mac">macOS</button>
              <button class="tab-btn" data-os="linux">Linux</button>
              <button class="tab-btn" data-os="win">Windows</button>
            </div>
            
            <div class="kicker">Install</div>
            <div class="copy-row" style="margin-bottom: 24px;">
              <input id="cli-install-cmd" class="input mono" readonly value="npm install -g streamdrop-cli" />
              <button class="btn btn-small" type="button" data-copy>Copy</button>
            </div>
            
            <div class="kicker" style="margin-bottom: 12px;">Usage</div>
            <pre class="mono" style="background: #1e1e1e; border: 1px solid var(--glass-border); padding: 16px; border-radius: 8px; font-size: 13px; overflow-x: auto; color: #e5e7eb; margin: 0; line-height: 1.6;"><span style="color: #6b7280;"># Send a file or folder</span>
<span style="color: #6b7280; user-select: none;">$</span> <span style="color: #10b981;">streamdrop</span> send ./my-file.zip

<span style="color: #6b7280;"># Receive a file</span>
<span style="color: #6b7280; user-select: none;">$</span> <span style="color: #10b981;">streamdrop</span> receive &lt;receive-code&gt;</pre>
          </div>
        </div>
      </div>

      <script nonce="${nonce}">
        window.__STREAMDROP_DEFAULT_SERVER__ = "${process.env.STREAMDROP_SERVER || "https://streamdrop.app"}"
        window.__STREAMDROP__=${config}
      </script>
      <script src="/static/vendor/qrcode.min.js"></script>
      <script type="module" src="/static/upload.js"></script>
    `,
  })
}

export function renderDownloadPage(session: Session, nonce: string) {
  const config = JSON.stringify({
    id: session.id,
    downloadToken: session.downloadToken,
    name: session.fileName,
    size: session.fileSize,
  })

  return htmlPage({
    title: "StreamDrop — Receive File",
    nonce,
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand" onclick="window.location.href='/'" style="cursor: pointer;">
            <div class="logo"><img class="logo-img" src="${LOGO_SRC}" alt="" /></div>
            <div>
              <h1>Receive</h1>
              <p>Decryption happens locally in your browser. The server never sees your file.</p>
            </div>
          </div>
          <a href="https://github.com/AntonyLeons/streamdrop" target="_blank" rel="noopener noreferrer" class="icon-btn" aria-label="GitHub Repository">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
          </a>
        </header>

        <section class="card">
          <div class="row">
            <div>
              <div class="kicker">Session</div>
              <div class="mono dim" style="font-size:12px;margin-top:3px">${escapeHtml(session.id)}</div>
            </div>
            <div class="top-controls">
              <button id="btn-cli-modal-dl" class="btn btn-small">StreamDrop CLI</button>
              <button id="theme-toggle" class="icon-btn" type="button" aria-label="Toggle theme">
                <span class="theme-icon theme-icon-sun" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="4"></circle>
                    <path d="M12 2v2"></path>
                    <path d="M12 20v2"></path>
                    <path d="M4.93 4.93l1.41 1.41"></path>
                    <path d="M17.66 17.66l1.41 1.41"></path>
                    <path d="M2 12h2"></path>
                    <path d="M20 12h2"></path>
                    <path d="M6.34 17.66l-1.41 1.41"></path>
                    <path d="M19.07 4.93l-1.41 1.41"></path>
                  </svg>
                </span>
                <span class="theme-icon theme-icon-moon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>
                  </svg>
                </span>
              </button>
              <a class="link" href="/">New transfer</a>
            </div>
          </div>

          <div class="badge-row">
            <div class="badge"><div class="badge-dot"></div>AES-256-GCM</div>
            <div class="badge"><div class="badge-dot"></div>Browser-side decrypt</div>
          </div>

          <div class="status" style="margin-top:16px">
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

      <div id="cli-modal" class="modal hidden">
        <div class="modal-backdrop"></div>
        <div class="modal-content">
          <div class="modal-header">
            <h2 style="margin:0;font-size:18px;">StreamDrop CLI</h2>
            <button class="icon-btn close-modal" aria-label="Close" style="width:24px;height:24px;padding:0;line-height:1;">&times;</button>
          </div>
          <div class="modal-body" style="font-size:14px;color:var(--fg-dim);">
            <p style="margin-top:0;margin-bottom:20px;">Transfer files directly from your terminal with end-to-end encryption.</p>
            
            <div class="tabs" style="display: flex; gap: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--glass-border);">
              <button class="tab-btn active" data-os="mac">macOS</button>
              <button class="tab-btn" data-os="linux">Linux</button>
              <button class="tab-btn" data-os="win">Windows</button>
            </div>
            
            <div class="kicker">Install</div>
            <div class="copy-row" style="margin-bottom: 24px;">
              <input id="cli-install-cmd" class="input mono" readonly value="brew install AntonyLeons/tap/streamdrop" />
              <button class="btn btn-small" type="button" data-copy>Copy</button>
            </div>
            
            <div class="kicker">Usage</div>
            <pre class="mono" style="background: var(--bg-2); padding: 12px; border-radius: 6px; font-size: 12px; overflow-x: auto; color: var(--fg); margin: 0; line-height: 1.5;"># Send a file or folder
streamdrop send ./my-file.zip

# Receive a file
streamdrop receive &lt;receive-code&gt;</pre>
          </div>
        </div>
      </div>

      <script nonce="${nonce}">window.__STREAMDROP__=${config}</script>
      <script type="module" src="/static/download.js"></script>
    `,
  })
}

export function renderNotFoundPage(nonce: string) {
  return htmlPage({
    title: "StreamDrop — Not Found",
    nonce,
    body: `
      <main class="shell">
        <header class="hero">
          <a class="brand link" href="/" style="cursor: pointer; text-decoration: none;">
            <div class="logo"><img class="logo-img" src="${LOGO_SRC}" alt="" /></div>
            <div><h1 style="color: var(--text);">StreamDrop</h1><p style="color: var(--text-muted);">Encrypted file transfer.</p></div>
          </a>
          <a href="https://github.com/AntonyLeons/streamdrop" target="_blank" rel="noopener noreferrer" class="icon-btn" aria-label="GitHub Repository">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
          </a>
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

export function renderServiceUnavailablePage(nonce: string) {
  return htmlPage({
    title: "StreamDrop — Busy",
    nonce,
    body: `
      <main class="shell">
        <header class="hero">
          <a class="brand link" href="/" style="cursor: pointer; text-decoration: none;">
            <div class="logo"><img class="logo-img" src="${LOGO_SRC}" alt="" /></div>
            <div><h1 style="color: var(--text);">StreamDrop</h1><p style="color: var(--text-muted);">Encrypted file transfer.</p></div>
          </a>
          <a href="https://github.com/AntonyLeons/streamdrop" target="_blank" rel="noopener noreferrer" class="icon-btn" aria-label="GitHub Repository">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
          </a>
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

function htmlPage(opts: { title: string; body: string; nonce: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="description" content="Zero-storage, end-to-end encrypted real-time file transfer. No accounts. No cloud." />
    <title>${escapeHtml(opts.title)}</title>
    <script nonce="${opts.nonce}">(()=>{try{const s=localStorage.getItem("sd_theme");const p=window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches;const t=s==="light"||s==="dark"?s:p?"light":"dark";document.documentElement.dataset.theme=t}catch{}})();</script>
    <link rel="icon" href="${LOGO_SRC}">
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
