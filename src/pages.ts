import type { Session } from "./sessions"

export function renderUploadPage(session: Session | null) {
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
              <div class="mono dim" style="font-size:12px;margin-top:3px">${session?.id ?? "—"}</div>
            </div>
            <a class="link" href="/recipes?ut=${session?.uploadToken ?? ''}&dt=${session?.downloadToken ?? ''}" id="recipes-link">CLI recipes</a>
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
              <div class="drop-title">Drop your file here</div>
              <div class="drop-sub">or click to browse · encrypted before upload</div>
            </div>
            <input id="file" class="file" type="file" />
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
              <div class="label">Wait</div>
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

          <div style="display:flex; gap:12px; align-items:center; margin-top:14px;">
            <div class="meter" style="flex:1; margin-top:0;"><div id="bar" class="bar"></div></div>
            <button id="cancel" class="btn hidden" type="button" style="padding: 6px 12px; font-size:11px;">Cancel</button>
          </div>
          <div id="meta" class="meta mono"></div>

          <div id="share" class="share hidden">
            <div class="share-grid">
              <div>
                <div class="kicker">Share link</div>
                <div class="copy-row">
                  <input id="link" class="input mono" readonly />
                  <button id="copy" class="btn" type="button">Copy</button>
                </div>
                <div class="kicker space-top">Receive (curl)</div>
                <div class="copy-row">
                  <input id="cmd-curl-dl" class="input mono" readonly />
                  <button class="btn cmd-copy" type="button">Copy</button>
                </div>
                <div class="kicker space-top">Receive (wget)</div>
                <div class="copy-row">
                  <input id="cmd-wget-dl" class="input mono" readonly />
                  <button class="btn cmd-copy" type="button">Copy</button>
                </div>
                <div class="kicker space-top">Send (curl)</div>
                <div class="copy-row">
                  <input id="cmd-curl-ul" class="input mono" readonly />
                  <button class="btn cmd-copy" type="button">Copy</button>
                </div>
              </div>
              <div class="qr-wrap">
                <div class="kicker">Scan to receive</div>
                <canvas id="qr" width="200" height="200" class="qr"></canvas>
              </div>
            </div>
          </div>

          <div id="error" class="error hidden"></div>
        </section>
      </main>

      <script>window.__STREAMDROP__=${config}</script>
      <script src="/static/vendor/qr-creator.min.js"></script>
      <script type="module" src="/static/upload.js"></script>
    `,
  })
}

export function renderDownloadPage(session: Session) {
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
              <div class="mono dim" style="font-size:12px;margin-top:3px">${session.id}</div>
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

      <script>window.__STREAMDROP__=${config}</script>
      <script type="module" src="/static/download.js"></script>
    `,
  })
}

export function renderRecipesPage(opts: { uploadToken?: string; downloadToken?: string } = {}) {
  const { uploadToken, downloadToken } = opts
  const dlPath = downloadToken ? `/d/${downloadToken}` : `/d/<downloadToken>`
  const upPath = uploadToken ? `/upload/${uploadToken}` : `/upload/<uploadToken>`

  const curlDl = `curl -L "HOST_PH${dlPath}" -o streamdrop.enc`.replaceAll('"', "&quot;")
  const wgetDl = `wget -O streamdrop.enc "HOST_PH${dlPath}"`.replaceAll('"', "&quot;")
  const curlUl = `curl -T streamdrop.enc "HOST_PH${upPath}"`.replaceAll('"', "&quot;")
  const tarUl = `tar czf - ./folder | curl -T - "HOST_PH${upPath}"`.replaceAll('"', "&quot;")
  const tarDl = `curl "HOST_PH${dlPath}" | tar xzf -`.replaceAll('"', "&quot;")

  return htmlPage({
    title: "StreamDrop — CLI Recipes",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div>
              <h1>CLI Recipes</h1>
              <p>Terminal tools transfer ciphertext only. Browsers hold the key.</p>
            </div>
          </div>
        </header>

        <section class="card">
          <div class="row" style="margin-bottom:20px">
            <a class="link" href="/">← Back</a>
            ${downloadToken ? `<span class="kicker">Session-specific tokens shown</span>` : `<span class="kicker">Using placeholder tokens</span>`}
          </div>

          <div class="kicker">Download ciphertext</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${curlDl}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>
          <div class="copy-row">
            <input class="input mono cmd-ph" value="${wgetDl}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker space-top">Upload ciphertext</div>
          <div class="copy-row">
            <input class="input mono cmd-ph" value="${curlUl}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker space-top">Pipe operations</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${tarUl}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>
          <div class="copy-row">
            <input class="input mono cmd-ph" value="${tarDl}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker space-top" style="margin-top:20px">Important</div>
          <div class="dim" style="font-size:13px;margin-top:8px;line-height:1.6">
            The decryption key is only in the browser link fragment
            <code style="font-family:var(--mono);color:var(--v-bright);font-size:12px">/<id>#<key></code>
            and is never sent to the server. CLI clients receive encrypted bytes only
            — open the share link in a browser to decrypt.
          </div>
        </section>
      </main>
      <script>
        document.querySelectorAll('.cmd-ph').forEach(el => { el.value = el.value.replace(/HOST_PH/g, location.origin) });
        document.querySelectorAll('.cmd-copy').forEach(btn => {
          btn.addEventListener('click', async () => {
            const input = btn.previousElementSibling;
            const val = input.value;
            try {
              await navigator.clipboard.writeText(val);
              const old = btn.textContent;
              btn.textContent = "Copied";
              setTimeout(() => btn.textContent = old, 900);
            } catch {
              input.select();
              document.execCommand('copy');
            }
          });
        });
      </script>
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
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
