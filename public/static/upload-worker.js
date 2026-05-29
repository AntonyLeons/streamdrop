import { createEncryptStream } from "./crypto.js"

let encryptStream = null
let reader = null

self.onmessage = async (e) => {
  const msg = e.data
  if (msg.type === "init") {
    const { keyBytes, sessionId, file, chunkSize } = msg
    
    // Import key
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"])
    
    // Create encryption stream
    encryptStream = createEncryptStream({
      stream: file.stream(),
      size: file.size,
      key,
      sessionId,
      chunkSize,
    })
    
    reader = encryptStream.getReader()
    
    // Start background encryption loop
    encryptLoop().catch((err) => {
      self.postMessage({ type: "error", message: err.message || String(err) })
    })
  } else if (msg.type === "abort") {
    cleanup()
  }
}

async function encryptLoop() {
  try {
    let encryptedBytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) {
        encryptedBytes += value.byteLength
        const buf = value.buffer
        // Transfer the array buffer to the main thread to avoid copy overhead
        self.postMessage({ type: "chunk", data: buf, bytes: encryptedBytes }, [buf])
      }
    }
    self.postMessage({ type: "complete" })
  } catch (err) {
    cleanup()
    throw err
  }
}

function cleanup() {
  if (reader) {
    reader.cancel().catch(() => {})
    reader = null
  }
}
