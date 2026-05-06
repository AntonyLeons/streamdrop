import { expect, test } from "bun:test"

function polyfillBase64() {
  ;(globalThis as any).btoa = (s: string) => Buffer.from(s, "binary").toString("base64")
  ;(globalThis as any).atob = (s: string) => Buffer.from(s, "base64").toString("binary")
}

polyfillBase64()

const cryptoMod = await import(new URL("../public/static/crypto.js", import.meta.url).toString())

test("encrypt->decrypt roundtrip (multi-chunk)", async () => {
  const plain = randomBytes(220_000)
  const file = makeFile(plain)
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])

  const enc = cryptoMod.createEncryptStream({ stream: file.stream(), size: file.size, key, sessionId: "test", chunkSize: 64 * 1024 })
  const cipher = await readAll(enc)

  const key2 = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(await crypto.subtle.exportKey("raw", key)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  )

  // Write concurrently with reading to avoid TransformStream backpressure deadlock
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const w = writable.getWriter()
  const dec = readable.pipeThrough(cryptoMod.createDecryptTransform({ key: key2, sessionId: "test" })) as ReadableStream<Uint8Array>

  const [roundtrip] = await Promise.all([
    readAll(dec),
    (async () => { await w.write(cipher); await w.close() })(),
  ])

  expect(Buffer.from(roundtrip)).toEqual(Buffer.from(plain))
})

test("decrypt detects tampering", async () => {
  const plain = randomBytes(140_000)
  const file = makeFile(plain)
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])

  const enc = cryptoMod.createEncryptStream({ stream: file.stream(), size: file.size, key, sessionId: "test2", chunkSize: 64 * 1024 })
  const cipher = await readAll(enc)
  const idx = Math.min(40, cipher.length - 1)
  cipher[idx] = (cipher[idx] ?? 0) ^ 0x01

  const key2 = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(await crypto.subtle.exportKey("raw", key)),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  )

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const w = writable.getWriter()
  const dec = readable.pipeThrough(cryptoMod.createDecryptTransform({ key: key2, sessionId: "test2" })) as ReadableStream<Uint8Array>

  await expect(
    Promise.all([
      readAll(dec),
      (async () => { await w.write(cipher); await w.close() })(),
    ])
  ).rejects.toBeTruthy()
})

function randomBytes(n: number) {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

function makeFile(bytes: Uint8Array) {
  const blob = new Blob([bytes])
  return {
    size: blob.size,
    stream: () => blob.stream(),
  }
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.byteLength
  }
  return out
}
