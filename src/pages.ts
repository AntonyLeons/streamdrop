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
            <a class="link" href="/recipes?id=${session?.id ?? ""}" id="recipes-link">CLI recipes</a>
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

          <div id="meta" class="meta mono"></div>

          <div id="share" class="share">
            <div class="kicker">Files</div>
            <div id="share-empty" class="dim" style="font-size:13px;margin-top:10px">Select files above to generate share links.</div>
            <div id="shares" class="shares"></div>
            <template id="share-item-template">
              <section class="share-item">
                <div class="share-row">
                  <div class="share-left">
                    <div class="mono share-filename"></div>
                    <div class="mono dim share-state"></div>
                    <div class="mono dim share-downloads"></div>
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
                    <button class="btn btn-small" type="button" data-copy data-copy-kind="curl">curl</button>
                    <button class="btn btn-small" type="button" data-copy data-copy-kind="wget">wget</button>
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

      <div id="recipes-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="CLI recipes">
        <div class="modal-backdrop" data-action="close-modal"></div>
        <div class="modal-panel">
          <div class="row" style="margin-bottom:14px">
            <div class="kicker">CLI Recipes</div>
            <button id="recipes-close" class="btn btn-small" type="button" data-action="close-modal">Close</button>
          </div>
          <div id="recipes-body"></div>
        </div>
      </div>

      <script>window.__STREAMDROP__=${config}</script>
      <script src="/static/vendor/qrcode.min.js"></script>
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

export function renderRecipesPage(opts: { id?: string; uploadToken?: string; downloadToken?: string } = {}) {
  const { id } = opts
  const createUrl = `HOST_PH/xfr`
  const humanUrl = id ? `HOST_PH/xfr/${id}` : `HOST_PH/xfr/<id>`
  const webUrl = id ? `HOST_PH/recv/${id}` : `HOST_PH/recv/<id>`

  const reqCurl = `curl -s -L "${createUrl}" | tee xfr.txt`.replaceAll('"', "&quot;")
  const reqWget = `wget -qO- "${createUrl}" | tee xfr.txt`.replaceAll('"', "&quot;")
  const sendCurl = `curl -T <myfile> -s -L -D - "${createUrl}/" | grep -i human`
  const sendWget = `wget --post-file <myfile> -S -o - "${createUrl}" | grep -i human`
  const recvCurl = `curl -s -J -O -L "<transfer_url>"`
  const recvWget = `wget --content-disposition "<transfer_url>"`

  return htmlPage({
    title: "StreamDrop — CLI Recipes",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div>
              <h1>CLI Recipes</h1>
              <p>Use StreamDrop to send and receive files from your terminal.</p>
            </div>
          </div>
        </header>

        <section class="card">
          <div class="row" style="margin-bottom:20px">
            <a class="link" href="/">← Back</a>
            ${id ? `<span class="kicker">Session link shown</span>` : `<span class="kicker">Using placeholder link</span>`}
          </div>

          <div class="kicker">Request a file (receiver-first)</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${reqCurl}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>
          <div class="copy-row">
            <input class="input mono cmd-ph" value="${reqWget}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker">Sending files</div>
          <div class="kicker space-top">Sending a file with cURL</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${sendCurl.replaceAll('"', "&quot;")}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker space-top">Sending a file with Wget</div>
          <div class="copy-row">
            <input class="input mono cmd-ph" value="${sendWget.replaceAll('"', "&quot;")}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="dim" style="font-size:13px;margin-top:12px;line-height:1.6">
            cURL and Wget won't stop by themselves — to stop hosting your file, press CTRL+C.
          </div>

          <div class="kicker space-top" style="margin-top:22px">Receiving files</div>
          ${id ? `
          <div class="kicker space-top">Direct download URL</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${humanUrl.replaceAll('"', "&quot;")}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>
          <div class="kicker space-top">Web URL</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${webUrl.replaceAll('"', "&quot;")}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>
          ` : ``}
          <div class="kicker space-top">Receiving a file with cURL</div>
          <div class="copy-row" style="margin-bottom:8px">
            <input class="input mono cmd-ph" value="${recvCurl.replaceAll('"', "&quot;")}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker space-top">Receiving a file with Wget</div>
          <div class="copy-row">
            <input class="input mono cmd-ph" value="${recvWget.replaceAll('"', "&quot;")}" readonly />
            <button class="btn cmd-copy" type="button">Copy</button>
          </div>

          <div class="kicker space-top" style="margin-top:22px">Note</div>
          <div class="dim" style="font-size:13px;margin-top:8px;line-height:1.6">
            This CLI mode is not end-to-end encrypted. The server can see file contents in transit.
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

export function renderXfrReceivePage(id: string) {
  const url = `/xfr/${id}`
  const sendUrl = `/send/${id}`
  return htmlPage({
    title: "StreamDrop — Receive (Plain)",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div><h1>Receive</h1><p>Plain transfer (no end-to-end encryption).</p></div>
          </div>
        </header>
        <section class="card" style="text-align:center">
          <div class="dim" style="font-size:13px;line-height:1.6">
            Open this page first, then share the send link with the sender. When you're ready, click Download to wait for the upload stream.
          </div>

          <div style="max-width:620px;margin:18px auto 0;text-align:left">
            <div class="kicker">Send link</div>
            <div class="copy-row">
              <input class="input mono" readonly value="HOST_PH${sendUrl}" />
              <button class="btn btn-small" type="button" data-copy>Copy</button>
            </div>

            <div class="kicker space-top">Direct download URL</div>
            <div class="copy-row">
              <input class="input mono" readonly value="HOST_PH${url}" />
              <button class="btn btn-small" type="button" data-copy>Copy</button>
            </div>
          </div>

          <a class="btn btn-primary link-btn" href="${url}" style="margin-top:18px;display:inline-block">Download</a>
        </section>
      </main>
      <script>
        document.querySelectorAll('[data-copy]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const input = btn.previousElementSibling;
            const val = input && input.tagName === 'INPUT' ? input.value : '';
            if (!val) return;
            try {
              await navigator.clipboard.writeText(val.replace(/HOST_PH/g, location.origin));
              const old = btn.textContent;
              btn.textContent = "Copied";
              setTimeout(() => btn.textContent = old, 900);
            } catch {}
          });
        });
        document.querySelectorAll('input.input.mono').forEach(el => { el.value = el.value.replace(/HOST_PH/g, location.origin) });
      </script>
    `,
  })
}

export function renderXfrSendPage(id: string) {
  const postUrl = `/xfr/${id}`
  return htmlPage({
    title: "StreamDrop — Send (Plain)",
    body: `
      <main class="shell">
        <header class="hero">
          <div class="brand">
            <div class="logo">SD</div>
            <div><h1>Send</h1><p>Plain transfer (no end-to-end encryption).</p></div>
          </div>
        </header>
        <section class="card">
          <div class="kicker">Select a file</div>
          <div class="copy-row" style="margin-top:10px">
            <input id="xfr-file" class="input" type="file" />
            <button id="xfr-send" class="btn btn-primary" type="button">Send</button>
          </div>
          <div id="xfr-status" class="dim" style="font-size:13px;margin-top:12px;line-height:1.6"></div>
          <div class="dim" style="font-size:13px;margin-top:10px;line-height:1.6">
            Keep this tab open until the receiver finishes downloading.
          </div>
        </section>
      </main>
      <script type="module">
        const elFile = document.getElementById("xfr-file");
        const elSend = document.getElementById("xfr-send");
        const elStatus = document.getElementById("xfr-status");
        const postUrl = "HOST_PH${postUrl}";

        function setStatus(t) { elStatus.textContent = t || ""; }

        elSend.addEventListener("click", async () => {
          const file = elFile.files && elFile.files[0];
          if (!file) return setStatus("Select a file first.");
          setStatus("Uploading...");
          elSend.disabled = true;
          try {
            const url = postUrl.replace(/HOST_PH/g, location.origin) + "?name=" + encodeURIComponent(file.name);
            const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file });
            if (!res.ok) throw new Error(await res.text());
            setStatus("Uploaded. Receiver can download now.");
          } catch (e) {
            setStatus(String(e?.message || e || "error"));
          } finally {
            elSend.disabled = false;
          }
        });
      </script>
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
