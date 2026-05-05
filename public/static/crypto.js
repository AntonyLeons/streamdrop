const MAGIC = new Uint8Array([0x53, 0x44, 0x31])
const HEADER_LEN = 3 + 4 + 12

export function base64urlEncode(bytes) {
  let s = btoa(String.fromCharCode(...bytes))
  s = s.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
  return s
}

export function base64urlDecode(s) {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function createEncryptStream({ stream, size, key, sessionId, chunkSize = 256 * 1024, onProgress }) {
  const baseIv = crypto.getRandomValues(new Uint8Array(12))
  const header = new Uint8Array(HEADER_LEN)
  header.set(MAGIC, 0)
  writeU32(header, 3, chunkSize)
  header.set(baseIv, 7)

  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(header)
      const reader = stream.getReader()
      let buf = new Uint8Array(0)
      let chunkIndex = 0
      let sent = 0

      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value || value.byteLength === 0) continue

          buf = concat2(buf, value)
          while (buf.byteLength >= chunkSize) {
            const chunk = buf.slice(0, chunkSize)
            buf = buf.slice(chunkSize)
            const frame = await encryptFrame({ chunk, key, baseIv, sessionId, chunkIndex, encoder })
            controller.enqueue(frame)
            sent += chunk.byteLength
            if (onProgress) onProgress(sent, size)
            chunkIndex++
          }
        }

        if (buf.byteLength > 0) {
          const frame = await encryptFrame({ chunk: buf, key, baseIv, sessionId, chunkIndex, encoder })
          controller.enqueue(frame)
          sent += buf.byteLength
          if (onProgress) onProgress(sent, size)
        }

        controller.close()
      } catch (e) {
        controller.error(e)
      } finally {
        reader.cancel().catch(() => { })
      }
    },
  })
}

export function createDecryptTransform({ key, sessionId, onProgress }) {
  const encoder = new TextEncoder()
  let buf = new Uint8Array(0)
  let headerParsed = false
  let chunkSize = 0
  let baseIv = null
  let expectedChunkIndex = 0
  let outBytes = 0

  return new TransformStream({
    async transform(chunk, controller) {
      if (chunk && chunk.byteLength) buf = concat2(buf, chunk)

      while (true) {
        if (!headerParsed) {
          if (buf.byteLength < HEADER_LEN) return
          const magic = buf.slice(0, 3)
          if (!eq3(magic, MAGIC)) throw new Error("bad_magic")
          chunkSize = readU32(buf, 3)
          baseIv = buf.slice(7, 19)
          buf = buf.slice(HEADER_LEN)
          headerParsed = true
          continue
        }

        if (buf.byteLength < 8) return
        const chunkIndex = readU32(buf, 0)
        const cipherLen = readU32(buf, 4)
        if (buf.byteLength < 8 + cipherLen) return
        if (chunkIndex !== expectedChunkIndex) throw new Error("bad_chunk_index")

        const cipher = buf.slice(8, 8 + cipherLen)
        buf = buf.slice(8 + cipherLen)

        const iv = deriveIv(baseIv, chunkIndex)
        const aad = encoder.encode(`streamdrop/v1|${sessionId}|${chunkIndex}`)
        const plainBuf = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          key,
          cipher,
        )
        const plain = new Uint8Array(plainBuf)
        controller.enqueue(plain)
        outBytes += plain.byteLength
        if (onProgress) onProgress(outBytes)
        expectedChunkIndex++
      }
    },
  })
}

async function encryptFrame({ chunk, key, baseIv, sessionId, chunkIndex, encoder }) {
  const iv = deriveIv(baseIv, chunkIndex)
  const aad = encoder.encode(`streamdrop/v1|${sessionId}|${chunkIndex}`)
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, chunk)
  const cipher = new Uint8Array(cipherBuf)
  const frame = new Uint8Array(8 + cipher.byteLength)
  writeU32(frame, 0, chunkIndex)
  writeU32(frame, 4, cipher.byteLength)
  frame.set(cipher, 8)
  return frame
}

function deriveIv(baseIv, chunkIndex) {
  const iv = new Uint8Array(baseIv)
  const x = chunkIndex >>> 0
  iv[8] ^= (x >>> 24) & 0xff
  iv[9] ^= (x >>> 16) & 0xff
  iv[10] ^= (x >>> 8) & 0xff
  iv[11] ^= x & 0xff
  return iv
}

function writeU32(target, offset, value) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength)
  view.setUint32(offset, value >>> 0, false)
}

function readU32(target, offset) {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength)
  return view.getUint32(offset, false)
}

function concat2(a, b) {
  if (!a.byteLength) return b
  if (!b.byteLength) return a
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function eq3(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

