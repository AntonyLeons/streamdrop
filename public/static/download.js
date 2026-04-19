import { base64urlDecode, createDecryptTransform } from "./crypto.js"

const cfg = window.__STREAMDROP__

const elStart = document.getElementById("start")
const elBar = document.getElementById("bar")
const elMeta = document.getElementById("meta")
const elHint = document.getElementById("hint")
const elError = document.getElementById("error")
const elCancel = document.getElementById("cancel")

const frag = location.hash.startsWith("#") ? location.hash.slice(1) : ""
const [keyFrag, ...nameParts] = frag.split(",")
let suggestedName = "streamdrop.bin"
if (nameParts.length > 0) {
  try {
    suggestedName = decodeURIComponent(nameParts.join(","))
  } catch {}
}

setStep("wait")
setMeta(`Waiting for ${suggestedName}. Click start when ready.`)

elStart.addEventListener("click", () => run().catch((e) => showError(String(e?.message ?? e ?? "error"))))

async function run() {
  clearError()

  if (!keyFrag) {
    showError("Missing key fragment. Use a link like /<id>#<key>.")
    return
  }

  elHint.textContent = "Connecting…"
  elStart.disabled = true
  elStart.textContent = "Running"
  elCancel.classList.remove("hidden")

  setStep("download")

  const raw = base64urlDecode(keyFrag)
  if (raw.byteLength !== 32) throw new Error("bad_key_length")
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"])

  const abortController = new AbortController()
  const onCancel = () => abortController.abort()
  elCancel.addEventListener("click", onCancel, { once: true })

  let res;
  try {
    res = await fetch(`/d/${cfg.downloadToken}`, {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      signal: abortController.signal
    })
  } catch (e) {
    elCancel.classList.add("hidden")
    elCancel.removeEventListener("click", onCancel)
    throw new Error(e?.message ?? "download_failed")
  }

  elCancel.classList.add("hidden")
  elCancel.removeEventListener("click", onCancel)

  if (!res.ok) {
    const msg = await safeText(res)
    throw new Error(msg || `download_failed_${res.status}`)
  }

  if (!res.body) throw new Error("missing_body")

  let plainBytes = 0
  const decrypt = createDecryptTransform({
    key,
    sessionId: cfg.id,
    onProgress: (n) => {
      plainBytes = n
      setMeta(`${prettyBytes(n)} decrypted`)
      setBar(0.12 + Math.min(0.88, (Math.log10(1 + n) / 8) * 0.88))
    },
  })

  setStep("decrypt")

  const plaintext = res.body.pipeThrough(decrypt)

  setStep("save")

  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName })
    const writable = await handle.createWritable()
    await plaintext.pipeTo(writable)
    setBar(1)
    setMeta(`${prettyBytes(plainBytes)} saved`)
    elHint.textContent = "Complete"
    elStart.textContent = "Done"
    return
  }

  const file = await streamToOPFS(plaintext)
  const url = URL.createObjectURL(file)
  const a = document.createElement("a")
  a.href = url
  a.download = suggestedName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setBar(1)
  setMeta(`${prettyBytes(plainBytes)} downloaded`)
  elHint.textContent = "Complete"
  elStart.textContent = "Done"
}

function setBar(pct) {
  elBar.style.width = `${Math.round(pct * 100)}%`
}

function setMeta(text) {
  elMeta.textContent = text
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

async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

async function streamToOPFS(stream) {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    // Ultimate fallback if OPFS unsupported
    const reader = stream.getReader()
    const chunks = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return new Blob(chunks, { type: "application/octet-stream" })
  }
  
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(`sd_${Date.now()}_${suggestedName}`, { create: true })
  
  // Use createSyncAccessHandle if available for performance, otherwise standard writable
  if (handle.createWritable) {
     const writable = await handle.createWritable()
     await stream.pipeTo(writable)
  } else {
     // Safari fallback
     const accessHandle = await handle.createSyncAccessHandle()
     const reader = stream.getReader()
     while (true) {
       const { value, done } = await reader.read()
       if (done) break
       if (value) accessHandle.write(value)
     }
     accessHandle.flush()
     accessHandle.close()
  }
  return await handle.getFile()
}

window.addEventListener("unhandledrejection", (e) => showError(String(e.reason?.message ?? e.reason ?? "error")))
window.addEventListener("error", (e) => showError(String(e.error?.message ?? e.message ?? "error")))

