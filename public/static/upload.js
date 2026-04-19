import { base64urlEncode, createEncryptStream } from "./crypto.js"

const seedCfg = window.__STREAMDROP__ || {}
let seedUsed = false

const elDrop = document.getElementById("dropzone")
const elFile = document.getElementById("file")
const elMeta = document.getElementById("meta")
const elShare = document.getElementById("share")
const elShares = document.getElementById("shares")
const elShareTemplate = document.getElementById("share-item-template")
const elShareEmpty = document.getElementById("share-empty")
const elError = document.getElementById("error")
const elRecipesLink = document.getElementById("recipes-link")
const elRecipesModal = document.getElementById("recipes-modal")
const elRecipesBody = document.getElementById("recipes-body")

setStep("key")

const liveBySessionId = new Map()

if (elRecipesLink) {
  elRecipesLink.addEventListener("click", (e) => {
    e.preventDefault()
    openRecipesModal()
  })
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && elRecipesModal && !elRecipesModal.classList.contains("hidden")) closeRecipesModal()
})

elDrop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") elFile.click()
})

elDrop.addEventListener("dragover", (e) => {
  e.preventDefault()
  elDrop.classList.add("drag")
})

elDrop.addEventListener("dragleave", () => elDrop.classList.remove("drag"))

elDrop.addEventListener("drop", (e) => {
  e.preventDefault()
  elDrop.classList.remove("drag")
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length > 0) handleFiles(files)
})

elFile.addEventListener("change", () => {
  const files = Array.from(elFile.files ?? [])
  if (files.length > 0) handleFiles(files)
  elFile.value = ""
})

document.addEventListener("click", async (e) => {
  const closeModalBtn = e.target?.closest?.('[data-action="close-modal"]')
  if (closeModalBtn) {
    closeRecipesModal()
    return
  }

  const openBtn = e.target?.closest?.('button[data-action="open-share"]')
  if (openBtn) {
    const root = openBtn.closest(".share-item")
    if (!root) return
    const shareUrl = root.dataset.shareUrl || ""
    if (shareUrl) window.open(shareUrl, "_blank", "noopener,noreferrer")
    return
  }

  const delBtn = e.target?.closest?.('button[data-action="delete"]')
  if (delBtn) {
    const root = delBtn.closest(".share-item")
    if (!root) return
    const sessionId = root.dataset.sessionId || ""
    const uploadToken = root.dataset.uploadToken || ""
    const c = abortControllersBySessionId.get(sessionId)
    if (c) c.abort()
    abortControllersBySessionId.delete(sessionId)
    const cleanup = cleanupBySessionId.get(sessionId)
    if (cleanup) cleanup().catch(() => {})
    cleanupBySessionId.delete(sessionId)
    if (uploadToken) fetch(`/session/${uploadToken}`, { method: "DELETE" }).catch(() => {})
    const live = liveBySessionId.get(sessionId)
    if (live) {
      live.close()
      liveBySessionId.delete(sessionId)
    }
    transferStats.delete(sessionId)
    root.remove()
    if (elShares.childElementCount === 0 && elShareEmpty) {
      elShareEmpty.classList.remove("hidden")
      setMeta("")
      setStep("key")
    }
    return
  }

  const toggleBtn = e.target?.closest?.('button[data-toggle="qr"]')
  if (toggleBtn) {
    const root = toggleBtn.closest(".share-item")
    if (!root) return
    const details = root.querySelector(".share-details")
    if (!details) return
    details.classList.toggle("hidden")
    if (!details.classList.contains("hidden") && root.dataset.qrRendered !== "1") {
      const elQr = root.querySelector(".share-qr")
      const text = root.dataset.shareUrl || ""
      try {
        if (window.QRCode && elQr && text) {
          const opts = {
            width: 200,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark: "#7c5cff", light: "#0d1020" },
          }
          window.QRCode.toCanvas(elQr, text, opts, (err) => {
            if (err) return
            root.dataset.qrRendered = "1"
          })
        }
      } catch {}
    }
    return
  }

  const btn = e.target?.closest?.("button[data-copy]")
  if (!btn) return

  let value = btn.dataset.copyValue
  if (!value) {
    const input = btn.previousElementSibling
    if (input && input.tagName === "INPUT") value = input.value
  }
  if (!value) return

  try {
    await navigator.clipboard.writeText(value)
    const old = btn.textContent
    btn.textContent = "Copied"
    setTimeout(() => (btn.textContent = old), 900)
  } catch {
    const input = btn.previousElementSibling
    if (input && input.tagName === "INPUT") {
      input.select()
      document.execCommand("copy")
    }
  }
})

const abortControllersBySessionId = new Map()
const cleanupBySessionId = new Map()
const transferStats = new Map()

function handleFiles(files) {
  clearError()
  for (const file of files) startTransfer(file).catch((e) => showError(String(e?.message ?? e ?? "error")))
}

async function startTransfer(file) {
  const session = await getOrCreateSession()

  setStep("key", true)
  setMeta(`${file.name} · ${prettyBytes(file.size)}`)

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key))
  const keyB64 = base64urlEncode(raw)
  const shareUrl = `${location.origin}/${session.id}#${keyB64},${encodeURIComponent(file.name)}`

  const downloadUrl = `${location.origin}/d/${session.downloadToken}`

  const item = createShareItem({
    file,
    shareUrl,
    downloadUrl,
  })
  item.root.dataset.sessionId = session.id
  item.root.dataset.uploadToken = session.uploadToken
  item.root.dataset.downloadToken = session.downloadToken
  ensureLive(session.id, item)
  if (elShareEmpty) elShareEmpty.classList.add("hidden")
  elShares.appendChild(item.root)

  const abortController = new AbortController()
  abortControllersBySessionId.set(session.id, abortController)

  transferStats.set(session.id, { done: 0, total: file.size, name: file.name })

  try {
    setStep("encrypt", true)
    item.setState("Encrypting")

    let lastPct = 0
    const encStream = createEncryptStream({
      file,
      key,
      sessionId: session.id,
      onProgress: (done, total) => {
        if (!total) return
        const pct = Math.min(1, done / total)
        if (pct - lastPct < 0.002 && pct < 1) return
        lastPct = pct
        item.setBar(pct)
        transferStats.set(session.id, { done, total, name: file.name })
      },
    })

    const { blob: cipherBlob, cleanup } = await streamToTempFileOrBlob(encStream, abortController.signal)
    cleanupBySessionId.set(session.id, cleanup)

    if (abortController.signal.aborted) return

    item.setEncrypted(true)
    item.setBar(0)
    setStep("wait", true)

    while (true) {
      transferStats.set(session.id, { done: 0, total: cipherBlob.size, name: file.name })
      item.setState("Waiting for receiver")
      await waitForReceiverOnline(session.id, abortController.signal)
      if (abortController.signal.aborted) return

      item.setState("Uploading")
      item.setBar(0)

      let res
      try {
        const uploadStream = wrapStreamWithProgress({
          stream: cipherBlob.stream(),
          total: cipherBlob.size,
          signal: abortController.signal,
          onProgress: (done, total) => {
            const pct = total ? Math.min(1, done / total) : 0
            item.setBar(pct)
            if (done > 0) setStep("stream", true)
            transferStats.set(session.id, { done, total, name: file.name })
          },
        })

        res = await fetch(`/upload/${session.uploadToken}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: uploadStream,
          duplex: "half",
          signal: abortController.signal,
        })
      } catch (e) {
        if (abortController.signal.aborted) return
        item.setState("Error")
        throw new Error(e?.message ?? "upload_failed")
      }

      if (!res.ok) {
        let err = ""
        try {
          const ct = res.headers.get("content-type") || ""
          if (ct.includes("application/json")) {
            const body = await res.json()
            if (body && typeof body.error === "string") err = body.error
          } else {
            err = await safeText(res)
          }
        } catch {}

        if (err === "receivers_lost" || err === "aborted") {
          setStep("wait", true)
          item.setState("Waiting for receiver")
          await sleep(250)
          continue
        }

        item.setState("Error")
        throw new Error(err || `upload_failed_${res.status}`)
      }

      item.setState("Ready")
      item.setBar(1)
      transferStats.set(session.id, { done: 1, total: 1, name: file.name })

      if (getActiveTransferCount() === 0 && transferStats.size > 0) {
        setStep("ready", true)
        setMeta("Ready. Share the links below.")
      }

      setStep("wait", true)
    }
  } finally {
    abortControllersBySessionId.delete(session.id)
  }
}

function setMeta(text) {
  elMeta.textContent = text
}

function setStep(name, keepDone = false) {
  const steps = Array.from(document.querySelectorAll(".step"))
  for (const step of steps) {
    const stepName = step.getAttribute("data-step")
    step.classList.remove("on")
    if (!keepDone) step.classList.remove("done")
    if (stepName === name) step.classList.add("on")
  }
  const i = steps.findIndex((s) => s.getAttribute("data-step") === name)
  for (let j = 0; j < i; j++) steps[j].classList.add("done")
}

function showError(msg) {
  elError.textContent = msg
  elError.classList.remove("hidden")
}

function clearError() {
  elError.textContent = ""
  elError.classList.add("hidden")
}

function getActiveTransferCount() {
  let active = 0
  for (const s of transferStats.values()) if ((s.done || 0) < (s.total || 0)) active++
  return active
}

function createShareItem({ file, shareUrl, downloadUrl }) {
  const frag = elShareTemplate.content.cloneNode(true)
  const root = frag.querySelector(".share-item")
  const elFilename = root.querySelector(".share-filename")
  const elState = root.querySelector(".share-state")
  const elDownloads = root.querySelector(".share-downloads")
  const elEncrypted = root.querySelector('[data-badge="encrypted"]')
  const elBar = root.querySelector(".share-bar")
  const elLink = root.querySelector(".share-link")
  const btnCurl = root.querySelector('button[data-copy-kind="curl"]')
  const btnWget = root.querySelector('button[data-copy-kind="wget"]')

  root.dataset.shareUrl = shareUrl
  root.dataset.qrRendered = "0"
  root.dataset.fileName = file.name

  elFilename.textContent = `${file.name} · ${prettyBytes(file.size)}`
  elState.textContent = "Waiting"
  if (elDownloads) elDownloads.textContent = "0 downloads"
  elLink.value = shareUrl

  if (btnCurl) btnCurl.dataset.copyValue = `curl -L "${downloadUrl}" -o streamdrop.enc`
  if (btnWget) btnWget.dataset.copyValue = `wget -O streamdrop.enc "${downloadUrl}"`

  return {
    root,
    setState: (s) => {
      elState.textContent = s
    },
    setDownloads: (n) => {
      if (!elDownloads) return
      elDownloads.textContent = `${n} download${n === 1 ? "" : "s"}`
    },
    setBar: (pct) => {
      if (!elBar) return
      elBar.style.width = `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`
    },
    setEncrypted: (v) => {
      if (!elEncrypted) return
      if (v) elEncrypted.classList.remove("hidden")
      else elEncrypted.classList.add("hidden")
    },
  }
}

function ensureLive(sessionId, item) {
  if (!sessionId) return
  if (liveBySessionId.has(sessionId)) return
  const es = new EventSource(`/live/${sessionId}`)
  es.onmessage = (e) => {
    if (!e?.data || e.data === "ping") return
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg && msg.type === "stats" && typeof msg.downloads === "number") {
      item.setDownloads(msg.downloads)
    }
  }
  liveBySessionId.set(sessionId, es)
}

function wrapStreamWithProgress({ stream, total, onProgress, signal }) {
  const reader = stream.getReader()
  let done = 0
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException("Aborted", "AbortError"))
        return
      }
      const r = await reader.read()
      if (r.done) {
        if (onProgress) onProgress(done, total)
        controller.close()
        return
      }
      if (r.value) {
        done += r.value.byteLength
        if (onProgress) onProgress(done, total)
        controller.enqueue(r.value)
      }
    },
    async cancel() {
      try {
        await reader.cancel()
      } catch {}
    },
  })
}

async function streamToTempFileOrBlob(stream, signal) {
  if (navigator.storage && navigator.storage.getDirectory) {
    const root = await navigator.storage.getDirectory()
    const name = `sd_enc_${Date.now()}_${Math.random().toString(16).slice(2)}`
    const handle = await root.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await stream.pipeTo(writable, { signal })
    const file = await handle.getFile()
    return {
      blob: file,
      cleanup: async () => {
        try {
          await root.removeEntry(name)
        } catch {}
      },
    }
  }

  const reader = stream.getReader()
  const chunks = []
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  const blob = new Blob(chunks, { type: "application/octet-stream" })
  return { blob, cleanup: async () => {} }
}

async function waitForReceiverOnline(sessionId, signal) {
  while (true) {
    if (signal?.aborted) return false
    let res
    try {
      res = await fetch(`/wait-receiver/${sessionId}`, { method: "GET", headers: { accept: "application/json" }, signal })
    } catch {
      if (signal?.aborted) return false
      await sleep(400)
      continue
    }

    if (res.ok) {
      try {
        const body = await res.json()
        if (body && body.ok) return true
      } catch {}
    }

    await sleep(400)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function openRecipesModal() {
  if (!elRecipesModal || !elRecipesBody) return
  elRecipesBody.textContent = ""

  const items = Array.from(document.querySelectorAll(".share-item"))
  if (items.length === 0) {
    elRecipesBody.innerHTML = `
      <div class="recipe-block">
        <div class="kicker">Use StreamDrop to send and receive files from your terminal</div>

        <div class="kicker space-top">Sending a file with cURL</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='curl -T &lt;myfile&gt; -s -L -D - "${location.origin}/xfr/" | grep -i human' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top">Sending a file with Wget</div>
        <div class="copy-row">
          <input class="input mono" readonly value='wget --post-file &lt;myfile&gt; -S -o - "${location.origin}/xfr" | grep -i human' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="dim" style="font-size:13px;margin-top:8px;line-height:1.6">
          The send command prints a transfer URL. Use that URL to download.
        </div>
        <div class="kicker space-top">Receiving a file with cURL</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='curl -s -J -O -L "&lt;transfer_url&gt;"' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top">Receiving a file with Wget</div>
        <div class="copy-row">
          <input class="input mono" readonly value='wget --content-disposition "&lt;transfer_url&gt;"' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top" style="margin-top:18px">Request a file (receiver-first)</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='curl -s -L "${location.origin}/xfr" | tee xfr.txt' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>
        <div class="copy-row">
          <input class="input mono" readonly value='wget -qO- "${location.origin}/xfr" | tee xfr.txt' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top" style="margin-top:18px">Note</div>
        <div class="dim" style="font-size:13px;margin-top:8px;line-height:1.6">
          This CLI mode is not end-to-end encrypted. The server can see file contents in transit.
        </div>
      </div>
    `
  } else {
    for (const item of items) {
      const fileName = item.dataset.fileName || "file"
      const sessionId = item.dataset.sessionId || "<id>"
      const host = location.origin
      const humanUrl = `${host}/xfr/${sessionId}`
      const webUrl = `${host}/recv/${sessionId}`
      const sendUrl = `${host}/send/${sessionId}`

      const block = document.createElement("section")
      block.className = "recipe-block"
      block.innerHTML = `
        <div class="row" style="margin-bottom:10px">
          <div class="mono" style="font-size:12px">${escapeHtml(fileName)}</div>
          <a class="link" href="/recipes?id=${encodeURIComponent(sessionId)}" target="_blank" rel="noreferrer">Open page</a>
        </div>

        <div class="kicker">Use StreamDrop to send and receive files from your terminal</div>

        <div class="dim" style="font-size:13px;margin-top:8px;line-height:1.6">
          Receiver-first: share the send link below with the sender, then click Download (or run the curl/wget receive command). The download waits until the sender starts uploading.
        </div>

        <div class="kicker space-top">Sending a file with cURL</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='curl -T &lt;myfile&gt; -s -L -D - "${host}/xfr/" | grep -i human' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top">Sending a file with Wget</div>
        <div class="copy-row">
          <input class="input mono" readonly value='wget --post-file &lt;myfile&gt; -S -o - "${host}/xfr" | grep -i human' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="dim" style="font-size:13px;margin-top:12px;line-height:1.6">
          cURL and Wget won't stop by themselves — to stop hosting your file, press CTRL+C.
        </div>

        <div class="kicker space-top">Receiving a file with cURL</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='curl -s -J -O -L "${humanUrl}"' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top">Receiving a file with Wget</div>
        <div class="copy-row">
          <input class="input mono" readonly value='wget --content-disposition "${humanUrl}"' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top" style="margin-top:18px">Links</div>
        <div class="kicker space-top">Send link</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='${sendUrl}' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>
        <div class="kicker space-top">Direct download URL</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='${humanUrl}' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>
        <div class="kicker space-top">Request page</div>
        <div class="copy-row">
          <input class="input mono" readonly value='${webUrl}' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top" style="margin-top:18px">Request a file (receiver-first)</div>
        <div class="copy-row" style="margin-bottom:8px">
          <input class="input mono" readonly value='curl -s -L "${host}/xfr" | tee xfr.txt' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>
        <div class="copy-row">
          <input class="input mono" readonly value='wget -qO- "${host}/xfr" | tee xfr.txt' />
          <button class="btn btn-small" type="button" data-copy>Copy</button>
        </div>

        <div class="kicker space-top" style="margin-top:18px">Note</div>
        <div class="dim" style="font-size:13px;margin-top:8px;line-height:1.6">
          This CLI mode is not end-to-end encrypted. The server can see file contents in transit.
        </div>
      `
      elRecipesBody.appendChild(block)
    }
  }

  elRecipesModal.classList.remove("hidden")
}

function closeRecipesModal() {
  if (!elRecipesModal) return
  elRecipesModal.classList.add("hidden")
}

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

async function getOrCreateSession() {
  if (!seedUsed && seedCfg && seedCfg.id && seedCfg.uploadToken && seedCfg.downloadToken) {
    seedUsed = true
    return seedCfg
  }

  const res = await fetch("/session", { method: "POST", headers: { accept: "application/json" } })
  if (!res.ok) {
    const msg = await safeText(res)
    throw new Error(msg || `session_failed_${res.status}`)
  }
  return await res.json()
}

function prettyBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

window.addEventListener("unhandledrejection", (e) => showError(String(e.reason?.message ?? e.reason ?? "error")))
window.addEventListener("error", (e) => showError(String(e.error?.message ?? e.message ?? "error")))
