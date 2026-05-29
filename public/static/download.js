import { base64urlDecode, createDecryptTransform } from "./crypto.js"

const cfg = window.__STREAMDROP__

const elStart = document.getElementById("start")
const elBar = document.getElementById("bar")
const elMeter = elBar ? elBar.parentElement : null
const elMeta = document.getElementById("meta")
const elHint = document.getElementById("hint")
const elError = document.getElementById("error")
const elCancel = document.getElementById("cancel")
const elThemeToggle = document.getElementById("theme-toggle")

const frag = location.hash.startsWith("#") ? location.hash.slice(1) : ""
const parts = frag.split(",")
const keyFrag = parts[0] ?? ""
// Last segment is a numeric byte-size appended by newer share links
const lastPart = parts[parts.length - 1] ?? ""
const hasSize = parts.length >= 3 && /^\d+$/.test(lastPart)
const nameParts = hasSize ? parts.slice(1, -1) : parts.slice(1)
let suggestedName = "streamdrop.bin"
if (nameParts.length > 0) {
  try {
    suggestedName = decodeURIComponent(nameParts.join(","))
  } catch {}
}
// Prefer size from URL fragment; fall back to server-side session value
const fileSize = hasSize ? parseInt(lastPart, 10) : (cfg.size || 0)

setMeta(`Waiting for ${suggestedName}${fileSize ? ` · ${prettyBytes(fileSize)}` : ""}. Click start when ready.`)

if (elHint) {
  elHint.textContent = keyFrag ? "Ready to decrypt and download." : "Requires a link with a key fragment."
}

let started = false
let activeAbortController = null

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

elStart.addEventListener("click", async () => {
  clearError()

  const raw = getKeyBytes()
  if (!raw) return
  startOnce(raw)
})

async function tryWebRTCDownload(raw) {
  return new Promise(async (resolve, reject) => {
    let p2pSse = null
    let peerConnection = null
    let timeoutId = null
    let finished = false

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (p2pSse) p2pSse.close()
      if (peerConnection) {
        try { peerConnection.close() } catch {}
      }
    }

    const fail = (err) => {
      if (finished) return
      finished = true
      cleanup()
      reject(err)
    }

    if (activeAbortController?.signal.aborted) {
      fail(new DOMException("Aborted", "AbortError"))
      return
    }
    activeAbortController?.signal.addEventListener("abort", () => {
      fail(new DOMException("Aborted", "AbortError"))
    }, { once: true })

    timeoutId = setTimeout(() => {
      fail(new Error("P2P negotiation timeout"))
    }, 8000)

    try {
      const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"])
      
      p2pSse = new EventSource(`/session/events/${cfg.downloadToken}`)
      
      peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      })

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          fetch(`/session/signal/${cfg.downloadToken}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "candidate", candidate: event.candidate })
          }).catch(() => {})
        }
      }

      p2pSse.addEventListener("signal", async (e) => {
        try {
          const signal = JSON.parse(e.data)
          if (signal.type === "answer") {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(signal))
          } else if (signal.type === "candidate" && signal.candidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate))
          }
        } catch {}
      })

      const channel = peerConnection.createDataChannel("file-transfer")
      channel.binaryType = "arraybuffer"
      
      let startTime = Date.now()
      let plainBytes = 0
      
      const decrypt = createDecryptTransform({
        key,
        sessionId: cfg.id,
        onProgress: (n) => {
          plainBytes = n
          setMeta(fileSize ? `${prettyBytes(n)} of ${prettyBytes(fileSize)}` : `${prettyBytes(n)} decrypted`)
          const elapsed = (Date.now() - startTime) / 1000
          if (elapsed > 0.5) {
            const speed = n / elapsed
            if (fileSize) {
              const eta = Math.round((fileSize - n) / speed)
              const etaStr = eta > 0 ? ` · ${eta}s left` : ""
              elHint.textContent = `Downloading (P2P) · ${formatSpeed(speed)}${etaStr}`
              setBar(Math.min(1, n / fileSize))
            } else {
              elHint.textContent = `Downloading (P2P) · ${formatSpeed(speed)}`
              setBar(0.12 + Math.min(0.88, (Math.log10(1 + n) / 8) * 0.88))
            }
          } else if (!fileSize) {
            setBar(0.12 + Math.min(0.88, (Math.log10(1 + n) / 8) * 0.88))
          }
        }
      })

      channel.onopen = async () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        
        elHint.textContent = "Connected (P2P)"
        setStep("download")
        if (elMeter) elMeter.classList.remove("hidden")
        setBar(0)
        
        let streamController = null
        const webrtcStream = new ReadableStream({
          start(controller) {
            streamController = controller
          },
          cancel() {
            fail(new Error("Stream canceled"))
          }
        })
        
        channel.onmessage = (e) => {
          if (finished) return
          if (typeof e.data === "string" && e.data === "EOF") {
            try { streamController.close() } catch {}
          } else {
            const bytes = typeof e.data === "string" ? new TextEncoder().encode(e.data) : new Uint8Array(e.data)
            try { streamController.enqueue(bytes) } catch {}
          }
        }
        
        channel.onerror = (err) => fail(err)
        channel.onclose = () => { try { streamController.close() } catch {} }

        try {
          const plaintext = webrtcStream.pipeThrough(decrypt)
          setStep("decrypt")
          setStep("save")
          
          const file = await streamToOPFS(plaintext, activeAbortController.signal)
          
          if (plainBytes === 0 || (fileSize > 0 && plainBytes !== fileSize)) {
            throw new Error(`Incomplete transfer: received ${plainBytes} bytes, expected ${fileSize} bytes`)
          }
          
          finished = true
          cleanup()
          
          const url = URL.createObjectURL(file)
          const a = document.createElement("a")
          a.href = url
          a.download = suggestedName
          document.body.appendChild(a)
          a.click()
          a.remove()
          
          setBar(1)
          setMeta(fileSize ? `${prettyBytes(plainBytes)} of ${prettyBytes(fileSize)} downloaded` : `${prettyBytes(plainBytes)} downloaded`)
          elHint.textContent = "Complete"
          elStart.disabled = false
          elStart.textContent = "Download again"
          elCancel.classList.add("hidden")
          if (elMeter) elMeter.classList.add("hidden")
          
          resolve(true)
        } catch (err) {
          fail(err)
        }
      }

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
          fail(new Error("P2P connection closed or failed"))
        }
      }

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      
      await fetch(`/session/signal/${cfg.downloadToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(offer)
      })
    } catch (err) {
      fail(err)
    }
  })
}

async function run({ raw }) {
  elHint.textContent = "Connecting…"
  elStart.disabled = true
  elStart.textContent = "Running"
  elCancel.classList.remove("hidden")

  setStep("download")

  activeAbortController = new AbortController()
  const onCancel = () => activeAbortController.abort()
  elCancel.addEventListener("click", onCancel, { once: true })

  try {
    try {
      console.log("Attempting WebRTC P2P...")
      const success = await tryWebRTCDownload(raw)
      if (success) return
    } catch (e) {
      console.warn("WebRTC P2P failed, falling back to HTTP relay:", e)
    }

    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"])

    let attempt = 0
    while (true) {
      attempt++
      if (activeAbortController.signal.aborted) return

      elHint.textContent = attempt > 1 ? `Reconnecting… (${attempt})` : "Connecting…"
      setStep("download")
      if (elMeter) elMeter.classList.remove("hidden")
      setBar(0)

      let res
      try {
        res = await fetch(`/d/${cfg.downloadToken}`, {
          method: "GET",
          headers: { accept: "application/octet-stream" },
           signal: activeAbortController.signal,
        })
      } catch {
        if (activeAbortController.signal.aborted) return
        await sleep(backoffMs(attempt))
        continue
      }

      if (!res.ok) {
        const err = await parseError(res)
        if (err === "done") {
          throw new Error("Transfer is finished. Ask the sender to start the transfer again.")
        }
        if (err === "not_found") {
          throw new Error("Session not found.")
        }
        // Retry on transient proxy/gateway errors (Cloudflare 524/502/503, etc.) and back-pressure
        if (err === "too_many_receivers" || res.status >= 500) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw new Error(err || `download_failed_${res.status}`)
      }

      if (!res.body) {
        await sleep(backoffMs(attempt))
        continue
      }

      let plainBytes = 0
      let startTime = Date.now()
      const decrypt = createDecryptTransform({
        key,
        sessionId: cfg.id,
        onProgress: (n) => {
          plainBytes = n
          setMeta(fileSize ? `${prettyBytes(n)} of ${prettyBytes(fileSize)}` : `${prettyBytes(n)} decrypted`)
          const elapsed = (Date.now() - startTime) / 1000
          if (elapsed > 0.5) {
            const speed = n / elapsed
            if (fileSize) {
              const eta = Math.round((fileSize - n) / speed)
              const etaStr = eta > 0 ? ` · ${eta}s left` : ""
              elHint.textContent = `Downloading · ${formatSpeed(speed)}${etaStr}`
              setBar(Math.min(1, n / fileSize))
            } else {
              elHint.textContent = `Downloading · ${formatSpeed(speed)}`
              setBar(0.12 + Math.min(0.88, (Math.log10(1 + n) / 8) * 0.88))
            }
          } else if (!fileSize) {
            setBar(0.12 + Math.min(0.88, (Math.log10(1 + n) / 8) * 0.88))
          }
        },
      })

      setStep("decrypt")

      const plaintext = res.body.pipeThrough(decrypt)

      setStep("save")

      try {
        const file = await streamToOPFS(plaintext, activeAbortController.signal)
        
        if (plainBytes === 0 || (fileSize > 0 && plainBytes !== fileSize)) {
          throw new Error(`Incomplete transfer: received ${plainBytes} bytes, expected ${fileSize} bytes`)
        }
        
        const url = URL.createObjectURL(file)
        const a = document.createElement("a")
        a.href = url
        a.download = suggestedName
        document.body.appendChild(a)
        a.click()
        a.remove()
        setBar(1)
        setMeta(fileSize ? `${prettyBytes(plainBytes)} of ${prettyBytes(fileSize)} downloaded` : `${prettyBytes(plainBytes)} downloaded`)
        elHint.textContent = "Complete"
        elStart.disabled = false
        elStart.textContent = "Download again"
        elCancel.classList.add("hidden")
        if (elMeter) elMeter.classList.add("hidden")
        return
      } catch (e) {
        if (activeAbortController.signal.aborted) return
        const msg = String(e?.message ?? e ?? "")
        if (msg.includes("bad_magic") || msg.includes("bad_chunk_index") || msg.includes("OperationError")) {
          await sleep(backoffMs(attempt))
          continue
        }
        throw e
      }
    }
  } finally {
    started = false
    elCancel.classList.add("hidden")
    elCancel.removeEventListener("click", onCancel)
    if (activeAbortController && activeAbortController.signal.aborted) {
      elHint.textContent = "Canceled"
      elStart.disabled = false
      elStart.textContent = "Start download"
    }
  }
}

function getKeyBytes() {
  if (!keyFrag) {
    showError("Missing key fragment. Use a link like /<id>#<key>.")
    return null
  }

  let raw
  try {
    raw = base64urlDecode(keyFrag)
  } catch {
    showError("bad_key")
    return null
  }
  if (raw.byteLength !== 32) {
    showError("bad_key_length")
    return null
  }
  return raw
}

function startOnce(raw) {
  if (started) return
  started = true
  run({ raw }).catch((e) => showError(String(e?.message ?? e ?? "error")))
}

function setBar(pct) {
  elBar.style.width = `${Math.round(pct * 100)}%`
}

function setMeta(text) {
  elMeta.textContent = text
}

window.addEventListener("beforeunload", (e) => {
  if (started && activeAbortController && !activeAbortController.signal.aborted) {
    e.preventDefault()
    e.returnValue = "You have an active download. Closing this page will stop it."
  }
})

function formatSpeed(bytesPerSec) {
  if (bytesPerSec === 0) return "0 B/s"
  const k = 1024
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"]
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k))
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

function setStep(name) {
  const steps = Array.from(document.querySelectorAll(".step"))
  for (const step of steps) {
    step.classList.remove("on")
    step.classList.remove("done")
  }
  const i = steps.findIndex((s) => s.getAttribute("data-step") === name)
  for (let j = 0; j < steps.length; j++) {
    if (j < i) steps[j].classList.add("done")
    if (j === i) steps[j].classList.add("on")
  }
}

function showError(msg) {
  elError.textContent = msg
  elError.classList.remove("hidden")
  elHint.textContent = "Error"
  started = false
  elStart.disabled = false
  elStart.textContent = "Start download"
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function backoffMs(attempt) {
  return Math.min(3000, 250 * Math.pow(1.6, Math.max(0, attempt - 1)))
}

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

async function parseError(res) {
  const ct = res.headers.get("content-type") || ""
  if (ct.includes("application/json")) {
    try {
      const body = await res.json()
      const e = body && typeof body.error === "string" ? body.error : ""
      if (e) return e
    } catch {}
  }
  return (await safeText(res)).trim()
}

async function streamToOPFS(stream, signal) {
  let root = null;
  let handle = null;
  let fileName = null;
  
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      root = await navigator.storage.getDirectory()
      fileName = `sd_${Date.now()}_${suggestedName}`
      handle = await root.getFileHandle(fileName, { create: true })
    }
  } catch (e) {
    root = null;
    handle = null;
  }

  if (!root || !handle) {
    // Ultimate fallback if OPFS unsupported or setup fails
    const reader = stream.getReader()
    const chunks = []
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return new Blob(chunks, { type: "application/octet-stream" })
  }
  
  // Use createSyncAccessHandle if available for performance, otherwise standard writable
  try {
    if (handle.createWritable) {
      const writable = await handle.createWritable()
      try {
        await stream.pipeTo(writable, { signal })
      } catch (e) {
        writable.abort().catch(() => {})
        throw e
      }
    } else {
      const accessHandle = await handle.createSyncAccessHandle()
      const reader = stream.getReader()
      try {
        while (true) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
          const { value, done } = await reader.read()
          if (done) break
          if (value) accessHandle.write(value)
        }
        accessHandle.flush()
      } finally {
        accessHandle.close()
        reader.cancel().catch(() => {})
      }
    }
    return await handle.getFile()
  } catch (e) {
    if (root && fileName) root.removeEntry(fileName).catch(() => {})
    throw e
  }
}

document.addEventListener("click", async (e) => {
  const cliModalBtn = e.target?.closest?.('#btn-cli-modal') || e.target?.closest?.('#btn-cli-modal-dl')
  if (cliModalBtn) {
    const modal = document.getElementById("cli-modal")
    if (modal) {
      modal.classList.remove("hidden")
    }
    return
  }

  const tabBtn = e.target?.closest?.('.tab-btn')
  if (tabBtn) {
    const os = tabBtn.dataset.os
    const cliInstallCmd = document.getElementById("cli-install-cmd")
    
    if (cliInstallCmd) {
      if (os === "npm") {
        cliInstallCmd.value = "npm install -g streamdrop-cli"
      } else if (os === "brew") {
        cliInstallCmd.value = "brew install AntonyLeons/tap/streamdrop-cli"
      } else if (os === "win") {
        cliInstallCmd.value = "scoop bucket add antonyleons https://github.com/AntonyLeons/scoop-bucket\nscoop install streamdrop-cli"
      }
    }
    document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn === tabBtn))
    return
  }

  const closeModalBtn = e.target?.closest?.('.close-modal') || (e.target?.classList.contains('modal-backdrop') ? e.target : null)
  if (closeModalBtn) {
    const modal = document.getElementById("cli-modal")
    if (modal) modal.classList.add("hidden")
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

  if (btn.textContent === "Copied") return
  try {
    await navigator.clipboard.writeText(value)
    const old = btn.textContent
    btn.style.minWidth = btn.offsetWidth + "px"
    btn.textContent = "Copied"
    setTimeout(() => { btn.textContent = old; btn.style.minWidth = "" }, 900)
  } catch {
    const input = btn.previousElementSibling
    if (input && input.tagName === "INPUT") {
      input.select()
      document.execCommand("copy")
    }
  }
})

window.addEventListener("unhandledrejection", (e) => showError(String(e.reason?.message ?? e.reason ?? "error")))
window.addEventListener("error", (e) => showError(String(e.error?.message ?? e.message ?? "error")))

const autoKey = getKeyBytes()
if (autoKey) {
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  
  if (isSafari || isIOS) {
    setMeta(`Ready to download ${suggestedName}${fileSize ? ` · ${prettyBytes(fileSize)}` : ""}`)
  } else {
    setMeta(`Starting ${suggestedName}…`)
    startOnce(autoKey)
  }
}
