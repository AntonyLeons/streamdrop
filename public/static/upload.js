import { base64urlEncode, createEncryptStream } from "./crypto.js"

const seedCfg = window.__STREAMDROP__ || {}
let seedUsed = false

const elDrop = document.getElementById("dropzone")
const elFile = document.getElementById("file")
const elMeta = document.getElementById("meta")
const elShares = document.getElementById("sd-files-list")
const elShareTemplate = document.getElementById("sd-file-template")
const elShareEmpty = document.getElementById("sd-files-empty")
const elError = document.getElementById("error")
const elCliToggle = document.getElementById("cli-toggle")
const elThemeToggle = document.getElementById("theme-toggle")

setStep("key")

let cliEnabled = false
const cliRawBySessionId = new Map()
const fileBySessionId = new Map()
const itemBySessionId = new Map()
const rawHostingBySessionId = new Set()

document.documentElement.classList.add("cli-off")
try {
  if (localStorage.getItem("sd_cli") === "1") enableCli(true)
} catch {}

if (elThemeToggle) {
  const syncThemeToggle = () => {
    const isLight = document.documentElement.dataset.theme === "light"
    elThemeToggle.setAttribute("aria-pressed", isLight ? "true" : "false")
    elThemeToggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme")
    elThemeToggle.title = isLight ? "Switch to dark theme" : "Switch to light theme"
  }

  syncThemeToggle()
  elThemeToggle.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem("sd_theme", theme)
    } catch {}
    syncThemeToggle()
  })
}

if (elCliToggle) {
  elCliToggle.addEventListener("change", () => {
    enableCli(!!elCliToggle.checked)
    try {
      localStorage.setItem("sd_cli", elCliToggle.checked ? "1" : "0")
    } catch {}
  })
}

function enableCli(on) {
  cliEnabled = !!on
  document.documentElement.classList.toggle("cli-off", !on)
  if (elCliToggle) elCliToggle.checked = !!on
  for (const item of document.querySelectorAll(".sd-file-item")) updateCliCopyValues(item)
}

function updateCliCopyValues(root) {
  const btnCurl = root.querySelector('button[data-copy-kind="curl"]')
  const btnWget = root.querySelector('button[data-copy-kind="wget"]')
  if (!btnCurl && !btnWget) return

  if (!cliEnabled) {
    if (btnCurl) delete btnCurl.dataset.copyValue
    if (btnWget) delete btnWget.dataset.copyValue
    return
  }

  ensureRawCliSession(root).catch(() => {})
}

async function ensureRawCliSession(root) {
  if (!cliEnabled) return
  const sessionId = root.dataset.sessionId || ""
  if (!sessionId) return
  const file = fileBySessionId.get(sessionId)
  const info = await getOrCreateCliRawSession(sessionId, file?.name || "")
  if (!info) return

  const btnCurl = root.querySelector('button[data-copy-kind="curl"]')
  const btnWget = root.querySelector('button[data-copy-kind="wget"]')
  const url = `${location.origin}/raw/d/${info.downloadToken}`
  if (btnCurl) btnCurl.dataset.copyValue = `curl -s -J -O -L "${url}"`
  if (btnWget) btnWget.dataset.copyValue = `wget --content-disposition "${url}"`

  const abort = abortControllersBySessionId.get(sessionId)
  if (file && abort) startRawHosting(sessionId, info, file, abort.signal)
}

async function getOrCreateCliRawSession(sessionId, fileName) {
  const existing = cliRawBySessionId.get(sessionId)
  if (existing) return existing

  const qs = fileName ? `?name=${encodeURIComponent(fileName)}` : ""
  const res = await fetch(`/session${qs}`, { method: "POST", headers: { accept: "application/json" } })
  if (!res.ok) return null
  const data = await res.json()
  if (!data || !data.id || !data.uploadToken || !data.downloadToken) return null
  cliRawBySessionId.set(sessionId, data)
  return data
}

async function startRawHosting(sessionId, rawSession, file, signal) {
  if (rawHostingBySessionId.has(sessionId)) return
  rawHostingBySessionId.add(sessionId)

  while (!signal.aborted) {
    if (!cliEnabled) {
      await sleep(250)
      continue
    }

    await waitForReceiverOnline(rawSession.id, signal)
    if (signal.aborted) return
    if (!cliEnabled) continue

    while (true) {
      const channelId = await claimChannel(rawSession.uploadToken, signal)
      if (!channelId) break

      try {
        const item = itemBySessionId.get(sessionId)
        if (item) {
          item.setState("Streaming")
          item.setBar(0)
        }

        const uploadStream = wrapStreamWithProgress({
          stream: file.stream(),
          total: file.size,
          signal,
          onProgress: (done, total) => {
            if (!item) return
            const pct = total ? Math.min(1, done / total) : 0
            item.setBar(pct)
            if (done > 0) {
              setStep("stream", true)
              markStepDone("stream")
            }
          },
        })

        const res = await fetch(
          `/raw/upload/${rawSession.uploadToken}/${encodeURIComponent(channelId)}?name=${encodeURIComponent(file.name)}`,
          {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: uploadStream,
            duplex: "half",
            signal,
          },
        )
        if (item && res.ok) {
          item.setBar(1)
          item.setState("Ready")
          setStep("ready", true)
          markStepDone("ready")
        }
      } catch {
        await sleep(250)
      }
    }
  }
}

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
  const nativeShareBtn = e.target?.closest?.('button[data-action="native-share"]')
  if (nativeShareBtn) {
    const root = nativeShareBtn.closest(".sd-file-item")
    if (!root) return
    const shareUrl = root.dataset.shareUrl || ""
    const fileName = root.dataset.fileName || "StreamDrop"
    if (!shareUrl) return

    const flash = (label) => {
      const oldAria = nativeShareBtn.dataset.nativeShareAria || nativeShareBtn.getAttribute("aria-label") || "Share"
      const oldTitle = nativeShareBtn.dataset.nativeShareTitle || nativeShareBtn.getAttribute("title") || "Share"
      nativeShareBtn.dataset.nativeShareAria = oldAria
      nativeShareBtn.dataset.nativeShareTitle = oldTitle
      nativeShareBtn.setAttribute("aria-label", label)
      nativeShareBtn.setAttribute("title", label)
      setTimeout(() => {
        nativeShareBtn.setAttribute("aria-label", oldAria)
        nativeShareBtn.setAttribute("title", oldTitle)
      }, 900)
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: fileName, text: fileName, url: shareUrl })
        flash("Shared")
        return
      } catch (err) {
        if (err && err.name === "AbortError") return
      }
    }

    try {
      await navigator.clipboard.writeText(shareUrl)
      flash("Copied")
    } catch {}
    return
  }

  const openBtn = e.target?.closest?.('button[data-action="open-link"]')
  if (openBtn) {
    const root = openBtn.closest(".sd-file-item")
    if (!root) return
    const shareUrl = root.dataset.shareUrl || ""
    if (shareUrl) window.open(shareUrl, "_blank", "noopener,noreferrer")
    return
  }

  const delBtn = e.target?.closest?.('button[data-action="delete"]')
  if (delBtn) {
    const root = delBtn.closest(".sd-file-item")
    if (!root) return
    const sessionId = root.dataset.sessionId || ""
    const uploadToken = root.dataset.uploadToken || ""
    const raw = cliRawBySessionId.get(sessionId)
    const c = abortControllersBySessionId.get(sessionId)
    if (c) c.abort()
    abortControllersBySessionId.delete(sessionId)
    const cleanup = cleanupBySessionId.get(sessionId)
    if (cleanup) cleanup().catch(() => {})
    cleanupBySessionId.delete(sessionId)
    if (uploadToken) fetch(`/session/${uploadToken}`, { method: "DELETE" }).catch(() => {})
    if (raw && raw.uploadToken) fetch(`/session/${raw.uploadToken}`, { method: "DELETE" }).catch(() => {})
    cliRawBySessionId.delete(sessionId)
    fileBySessionId.delete(sessionId)
    itemBySessionId.delete(sessionId)
    rawHostingBySessionId.delete(sessionId)
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
    const root = toggleBtn.closest(".sd-file-item")
    if (!root) return
    const details = root.querySelector(".sd-file-details")
    if (!details) return
    details.classList.toggle("hidden")
    if (!details.classList.contains("hidden") && root.dataset.qrRendered !== "1") {
      const elQr = root.querySelector(".sd-file-qr")
      const text = root.dataset.shareUrl || ""
      try {
        if (window.QRCode && elQr && text) {
          const style = getComputedStyle(document.documentElement)
          const dark = style.getPropertyValue("--v").trim() || "#22d3ee"
          const light = style.getPropertyValue("--bg").trim() || "#0d1020"
          const opts = {
            width: 200,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark, light },
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

  const item = createShareItem({
    file,
    shareUrl,
  })
  item.root.dataset.sessionId = session.id
  item.root.dataset.uploadToken = session.uploadToken
  item.root.dataset.downloadToken = session.downloadToken
  fileBySessionId.set(session.id, file)
  itemBySessionId.set(session.id, item)
  updateCliCopyValues(item.root)
  if (elShareEmpty) elShareEmpty.classList.add("hidden")
  elShares.prepend(item.root)

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
    item.setState("Ready")
    item.setBar(1)
    transferStats.set(session.id, { done: 1, total: 1, name: file.name })
    setMeta("Ready. Share the links below.")

    let activeUploads = 0
    const inFlight = new Set()

    const startChannelUpload = async (channelId) => {
      activeUploads++
      item.setState(activeUploads > 1 ? `Uploading (${activeUploads})` : "Uploading")
      try {
        let res
        try {
          const uploadStream = wrapStreamWithProgress({
            stream: cipherBlob.stream(),
            total: cipherBlob.size,
            signal: abortController.signal,
            onProgress: (done, total) => {
              if (activeUploads !== 1) return
              const pct = total ? Math.min(1, done / total) : 0
              item.setBar(pct)
              if (done > 0) {
                setStep("stream", true)
                markStepDone("stream")
              }
            },
          })

          res = await fetch(`/upload/${session.uploadToken}/${encodeURIComponent(channelId)}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: uploadStream,
            duplex: "half",
            signal: abortController.signal,
          })
        } catch (e) {
          if (abortController.signal.aborted) return
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

          if (err === "receivers_lost" || err === "aborted" || err === "channel_not_found") return
          throw new Error(err || `upload_failed_${res.status}`)
        }

        setStep("ready", true)
        markStepDone("ready")
      } finally {
        activeUploads--
        if (!abortController.signal.aborted) {
          item.setState(activeUploads > 0 ? `Uploading (${activeUploads})` : "Ready")
          if (activeUploads === 0) item.setBar(1)
        }
      }
    }

    while (true) {
      item.setState(activeUploads > 0 ? `Uploading (${activeUploads})` : "Waiting for receiver")
      await waitForReceiverOnline(session.id, abortController.signal)
      if (abortController.signal.aborted) return

      while (true) {
        const channelId = await claimChannel(session.uploadToken, abortController.signal)
        if (!channelId) break
        const p = startChannelUpload(channelId)
        inFlight.add(p)
        p.finally(() => inFlight.delete(p))
      }

      await sleep(250)
    }
  } finally {
    abortControllersBySessionId.delete(session.id)
  }
}

async function claimChannel(uploadToken, signal) {
  let res
  try {
    res = await fetch(`/claim/${uploadToken}`, { method: "POST", headers: { accept: "application/json" }, signal })
  } catch {
    if (signal?.aborted) return null
    await sleep(250)
    return null
  }

  if (res.status === 204) return null
  if (!res.ok) return null
  try {
    const body = await res.json()
    if (body && typeof body.channelId === "string") return body.channelId
  } catch {}
  return null
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

function markStepDone(name) {
  const step = document.querySelector(`.step[data-step="${name}"]`)
  if (step) step.classList.add("done")
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

function createShareItem({ file, shareUrl }) {
  const frag = elShareTemplate.content.cloneNode(true)
  const root = frag.querySelector(".sd-file-item")
  const elFilename = root.querySelector(".sd-file-name")
  const elState = root.querySelector(".sd-file-state")
  const elEncrypted = root.querySelector('[data-badge="encrypted"]')
  const elBar = root.querySelector(".sd-file-bar")
  const elMeter = elBar ? elBar.closest(".meter") : null
  const elLink = root.querySelector(".sd-file-link")
  const elNativeShare = root.querySelector('button[data-action="native-share"]')

  root.dataset.shareUrl = shareUrl
  root.dataset.qrRendered = "0"
  root.dataset.fileName = file.name

  elFilename.textContent = `${file.name} · ${prettyBytes(file.size)}`
  elState.textContent = "Waiting"
  elLink.value = shareUrl
  if (elNativeShare) {
    if (navigator.share) elNativeShare.classList.remove("hidden")
    else elNativeShare.classList.add("hidden")
  }

  return {
    root,
    setState: (s) => {
      elState.textContent = s
    },
    setBar: (pct) => {
      if (!elBar) return
      const clamped = Math.max(0, Math.min(1, pct))
      if (elMeter) elMeter.classList.remove("hidden")
      elBar.style.width = `${Math.round(clamped * 100)}%`
      if (clamped >= 1 && elMeter) setTimeout(() => elMeter.classList.add("hidden"), 400)
    },
    setEncrypted: (v) => {
      if (!elEncrypted) return
      if (v) elEncrypted.classList.remove("hidden")
      else elEncrypted.classList.add("hidden")
    },
  }
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
