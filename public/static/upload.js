import { base64urlEncode, createEncryptStream } from "./crypto.js"

const cfg = window.__STREAMDROP__
if (cfg && cfg.id) new EventSource(`/live/${cfg.id}`)

const elDrop = document.getElementById("dropzone")
const elFile = document.getElementById("file")
const elBar = document.getElementById("bar")
const elMeta = document.getElementById("meta")
const elShare = document.getElementById("share")
const elLink = document.getElementById("link")
const elCopy = document.getElementById("copy")
const elQr = document.getElementById("qr")
const elCmdCurlDl = document.getElementById("cmd-curl-dl")
const elCmdWgetDl = document.getElementById("cmd-wget-dl")
const elCmdCurlUl = document.getElementById("cmd-curl-ul")
const elError = document.getElementById("error")
const elCancel = document.getElementById("cancel")

setStep("key")

// Keyboard accessibility only — the overlay <input> already handles mouse clicks
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
  const file = e.dataTransfer?.files?.[0]
  if (file) handleFile(file)
})

elFile.addEventListener("change", () => {
  const file = elFile.files?.[0]
  if (file) handleFile(file)
})

elCopy.addEventListener("click", async () => {
  const value = elLink.value
  try {
    await navigator.clipboard.writeText(value)
    elCopy.textContent = "Copied"
    setTimeout(() => (elCopy.textContent = "Copy"), 900)
  } catch {
    elLink.select()
    document.execCommand("copy")
  }
})

document.querySelectorAll(".cmd-copy").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const input = btn.previousElementSibling
    const value = input.value
    try {
      await navigator.clipboard.writeText(value)
      const old = btn.textContent
      btn.textContent = "Copied"
      setTimeout(() => (btn.textContent = old), 900)
    } catch {
      input.select()
      document.execCommand("copy")
    }
  })
})

async function handleFile(file) {
  clearError()
  setStep("key", true)
  setMeta(`${file.name} · ${prettyBytes(file.size)}`)

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key))
  const keyB64 = base64urlEncode(raw)
  const shareUrl = `${location.origin}/${cfg.id}#${keyB64},${encodeURIComponent(file.name)}`

  elLink.value = shareUrl
  elShare.classList.remove("hidden")

  const downloadUrl = `${location.origin}/d/${cfg.downloadToken}`
  const uploadUrl = `${location.origin}/upload/${cfg.uploadToken}`
  
  elCmdCurlDl.value = `curl -L "${downloadUrl}" -o streamdrop.enc`
  elCmdWgetDl.value = `wget -O streamdrop.enc "${downloadUrl}"`
  elCmdCurlUl.value = `curl -T streamdrop.enc "${uploadUrl}"`

  try {
    if (window.QrCreator && elQr) {
      window.QrCreator.render(
        {
          text: shareUrl,
          radius: 0.4,
          ecLevel: "M",
          fill: {
            type: "linear-gradient",
            position: [0, 0, 1, 1],
            colorStops: [
              [0, "#a78bff"],
              [1, "#7c5cff"],
            ],
          },
          background: "#0d1020",
          size: 200,
        },
        elQr,
      )
    }
  } catch {}

  setStep("wait")
  elCancel.classList.remove("hidden")

  const abortController = new AbortController()
  const onCancel = () => abortController.abort()
  elCancel.addEventListener("click", onCancel, { once: true })

  let lastPct = 0
  let isStreaming = false
  const stream = createEncryptStream({
    file,
    key,
    sessionId: cfg.id,
    onProgress: (done, total) => {
      if (!isStreaming && done > 0) {
        isStreaming = true
        setStep("stream")
      }
      if (!total) return
      const pct = Math.min(1, done / total)
      if (pct - lastPct < 0.002 && pct < 1) return
      lastPct = pct
      setBar(pct)
      setMeta(`${file.name} · ${prettyBytes(done)} / ${prettyBytes(total)}`)
    },
  })

  const fetchOpts = {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: stream,
    duplex: "half",
    signal: abortController.signal
  }

  let res;
  try {
    res = await fetch(`/upload/${cfg.uploadToken}`, fetchOpts)
  } catch (e) {
    elCancel.classList.add("hidden")
    elCancel.removeEventListener("click", onCancel)
    throw new Error(e?.message ?? "upload_failed")
  }

  elCancel.classList.add("hidden")
  elCancel.removeEventListener("click", onCancel)

  if (!res.ok) {
    const msg = await safeText(res)
    throw new Error(msg || `upload_failed_${res.status}`)
  }

  setStep("ready")
  setBar(1)
  setMeta("Ready. Share the link or QR.")
}

function setBar(pct) {
  elBar.style.width = `${Math.round(pct * 100)}%`
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

