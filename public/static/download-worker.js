import { createDecryptTransform } from "./crypto.js"

let streamController = null
let decryptStream = null
let reader = null
let accessHandle = null
let root = null
let fileHandle = null
let fileName = ""
let plainBytes = 0
let useOPFS = true
let chunks = []

self.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === "init") {
    const { keyBytes, sessionId, suggestedName } = msg
    fileName = `sd_${Date.now()}_${suggestedName.replace(/[\\/]/g, "_")}`
    
    // Import key
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"])
    
    // Create readable stream for incoming encrypted chunks
    decryptStream = new ReadableStream({
      start(controller) {
        streamController = controller
      }
    })
    
    // Create decryption transform
    const decrypt = createDecryptTransform({
      key,
      sessionId,
      onProgress: (n) => {
        plainBytes = n
        self.postMessage({ type: "progress", bytes: n })
      }
    })
    
    // Setup OPFS and SyncAccessHandle
    try {
      root = await navigator.storage.getDirectory()
      fileHandle = await root.getFileHandle(fileName, { create: true })
      accessHandle = await fileHandle.createSyncAccessHandle()
    } catch (err) {
      console.warn("Worker: Failed to initialize OPFS, falling back to Blob storage:", err)
      useOPFS = false
    }
    
    // Start piping decrypted stream to OPFS synchronously
    const plainStream = decryptStream.pipeThrough(decrypt)
    reader = plainStream.getReader()
    
    // Launch a background reader loop
    readLoop().catch((err) => {
      self.postMessage({ type: "error", message: err.message || String(err) })
    })
  } else if (msg.type === "chunk") {
    if (streamController) {
      streamController.enqueue(new Uint8Array(msg.data))
    }
  } else if (msg.type === "eof") {
    if (streamController) {
      try { streamController.close() } catch {}
    }
  } else if (msg.type === "abort") {
    cleanup()
  }
}

async function readLoop() {
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        if (useOPFS) {
          accessHandle.write(value)
        } else {
          chunks.push(value)
        }
      }
    }
    
    let file
    let opfsName = ""
    if (useOPFS) {
      accessHandle.flush()
      accessHandle.close()
      accessHandle = null
      file = await fileHandle.getFile()
      // Keep the OPFS file alive until the main thread's download manager
      // has finished reading it — getFile() may return a lazy reference
      // backed by OPFS, not an in-memory snapshot, so removing it here
      // would break large downloads. The main thread schedules removal
      // after the download has had time to drain.
      opfsName = fileName
    } else {
      file = new Blob(chunks, { type: "application/octet-stream" })
    }
    
    self.postMessage({ type: "complete", file, opfsName })
  } catch (err) {
    cleanup()
    throw err
  }
}

function cleanup() {
  if (accessHandle) {
    try { accessHandle.close() } catch {}
    accessHandle = null
  }
  if (root && fileName) {
    root.removeEntry(fileName).catch(() => {})
  }
  chunks = []
}
