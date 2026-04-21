import QRCode from "qrcode"
import { createDecryptTransform, createEncryptStream } from "../public/static/crypto.js"
import { basename } from "node:path"

type SessionRes = { id: string; uploadToken: string; downloadToken: string }

const DEFAULT_SERVER = "https://streamdrop.app"

const argv = Bun.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp()
  process.exit(0)
}

if (cmd !== "send" && cmd !== "receive" && cmd !== "recv") {
  printHelp()
  process.exit(1)
}

if (cmd === "send") {
  const filePath = argv[1]
  if (!filePath) {
    printHelp()
    process.exit(1)
  }
  const server = getFlagValue("--server") ?? Bun.env.STREAMDROP_SERVER ?? DEFAULT_SERVER
  await runSend(server, filePath)
} else {
  const input = argv[1]
  if (!input) {
    printHelp()
    process.exit(1)
  }
  const overrideServer = getFlagValue("--server") ?? Bun.env.STREAMDROP_SERVER
  await runReceive(input, overrideServer)
}

function printHelp() {
  console.log(`streamdrop

Usage:
  streamdrop send <file> [--server <url>]
  streamdrop receive <share-url> [--server <url>]

Environment:
  STREAMDROP_SERVER

Default server:
  ${DEFAULT_SERVER}
`)
}

function getFlagValue(name: string) {
  const i = argv.indexOf(name)
  if (i === -1) return null
  const v = argv[i + 1]
  if (!v || v.startsWith("--")) return null
  return v
}

function normalizeServer(s: string) {
  try {
    const u = new URL(s)
    return u.origin
  } catch {
    return s.replace(/\/+$/, "")
  }
}

function randInt(n: number) {
  const x = crypto.getRandomValues(new Uint32Array(1))[0]!
  return x % n
}

function base64urlEncode(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function base64urlDecode(s: string) {
  const padded = s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)
  return new Uint8Array(Buffer.from(padded, "base64"))
}

async function runSend(serverRaw: string, filePath: string) {
  const server = normalizeServer(serverRaw)
  const file = Bun.file(filePath)
  if (!(await file.exists())) throw new Error("file_not_found")

  const fileName = basename(filePath)
  const sess = (await fetchJson(`${server}/session?name=${encodeURIComponent(fileName)}`, { method: "POST" })) as SessionRes
  if (!sess?.id || !sess.uploadToken || !sess.downloadToken) throw new Error("session_failed")

  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const keyFrag = base64urlEncode(rawKey)
  const shareUrl = `${server}/${sess.id}#${keyFrag},${encodeURIComponent(fileName)}`

  console.log(`Share URL: ${shareUrl}`)
  console.log(`Receive: streamdrop receive "${shareUrl}" --server ${server}`)
  try {
    const qr = await QRCode.toString(shareUrl, { type: "terminal", small: true })
    console.log(qr.trimEnd())
  } catch {}

  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"])

  while (true) {
    const ok = await waitForReceiver(server, sess.id)
    if (!ok) continue
    while (true) {
      const channelId = await claim(server, sess.uploadToken)
      if (!channelId) break
      const enc = createEncryptStream({ file, key, sessionId: sess.id, onProgress: undefined })
      const res = await fetch(`${server}/upload/${sess.uploadToken}/${encodeURIComponent(channelId)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: enc,
        duplex: "half",
      } as any)
      if (!res.ok) {
        const t = await safeText(res)
        console.error(`upload_failed: ${t || res.status}`)
      }
    }
    await sleep(250)
  }
}

async function runReceive(input: string, overrideServer?: string | null) {
  const parsed = parseShareInput(input)
  const server = normalizeServer(overrideServer ?? parsed.server ?? DEFAULT_SERVER)

  const cfg = await fetchSessionCfg(server, parsed.id)
  const downloadToken = cfg?.downloadToken
  if (typeof downloadToken !== "string" || !downloadToken) throw new Error("missing_download_token")

  const keyBytes = base64urlDecode(parsed.keyFrag)
  if (keyBytes.byteLength !== 32) throw new Error("bad_key")
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"])

  const outName = safeOutName(parsed.fileName || cfg.fileName || "streamdrop.bin")
  const outPath = `./${outName}`

  const res = await fetch(`${server}/d/${downloadToken}`, { method: "GET", headers: { accept: "application/octet-stream" } })
  if (!res.ok || !res.body) throw new Error(`download_failed_${res.status}`)

  const decrypt = createDecryptTransform({ key, sessionId: parsed.id, onProgress: undefined })
  const plain = res.body.pipeThrough(decrypt)
  await writeToFile(outPath, plain)
  console.log(`Saved: ${outPath}`)
}

function parseShareInput(input: string): { server?: string; id: string; keyFrag: string; fileName?: string } {
  const s = input.trim()
  let url: URL | null = null
  if (s.startsWith("http://") || s.startsWith("https://")) {
    url = new URL(s)
  } else if (s.includes("#")) {
    url = new URL(`http://placeholder${s.startsWith("/") ? "" : "/"}${s}`)
  } else {
    throw new Error("bad_share_url")
  }

  const id = url.pathname.split("/").filter(Boolean)[0] || ""
  if (!id) throw new Error("missing_id")

  const frag = url.hash.startsWith("#") ? url.hash.slice(1) : ""
  const [keyFrag, ...nameParts] = frag.split(",")
  if (!keyFrag) throw new Error("missing_key")

  let fileName: string | undefined
  if (nameParts.length > 0) {
    try {
      fileName = decodeURIComponent(nameParts.join(","))
    } catch {
      fileName = nameParts.join(",")
    }
  }

  const server = s.startsWith("http://") || s.startsWith("https://") ? url.origin : undefined
  return { server, id, keyFrag, fileName }
}

function safeOutName(name: string) {
  const base = name.split(/[\\/]/).pop() || "streamdrop.bin"
  const cleaned = base.replaceAll(/[\r\n"]/g, "").trim()
  return cleaned || "streamdrop.bin"
}

async function fetchSessionCfg(server: string, id: string) {
  const res = await fetch(`${server}/${encodeURIComponent(id)}`, { headers: { accept: "text/html" } })
  if (!res.ok) throw new Error(`session_page_failed_${res.status}`)
  const html = await res.text()
  const marker = "window.__STREAMDROP__="
  const i = html.indexOf(marker)
  if (i === -1) throw new Error("missing_cfg")
  const j = html.indexOf("</script>", i)
  if (j === -1) throw new Error("missing_cfg_end")
  const raw = html.slice(i + marker.length, j).trim().replace(/;$/, "")
  try {
    return JSON.parse(raw) as any
  } catch {
    throw new Error("bad_cfg_json")
  }
}

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), accept: "application/json" } })
  if (!res.ok) {
    const t = await safeText(res)
    throw new Error(t || `http_${res.status}`)
  }
  return await res.json()
}

async function safeText(res: Response) {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

async function waitForReceiver(server: string, sessionId: string) {
  try {
    const res = await fetch(`${server}/wait-receiver/${sessionId}`, { method: "GET", headers: { accept: "application/json" } })
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as any
    return !!body?.ok
  } catch {
    return false
  }
}

async function claim(server: string, uploadToken: string) {
  try {
    const res = await fetch(`${server}/claim/${uploadToken}`, { method: "POST", headers: { accept: "application/json" } })
    if (res.status === 204) return null
    if (!res.ok) return null
    const body = (await res.json().catch(() => null)) as any
    return typeof body?.channelId === "string" ? body.channelId : null
  } catch {
    return null
  }
}

async function writeToFile(path: string, stream: ReadableStream<Uint8Array>) {
  const w = Bun.file(path).writer()
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) w.write(value)
    }
  } finally {
    reader.cancel().catch(() => {})
    await w.end()
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
