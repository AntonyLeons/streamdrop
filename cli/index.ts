import QRCode from "qrcode"
import { createDecryptTransform, createEncryptStream } from "../public/static/crypto.js"
import { basename, extname, dirname, join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { stat as statFs } from "node:fs/promises"
import { homedir } from "node:os"

type SessionRes = { id: string; uploadToken: string; downloadToken: string }

const DEFAULT_SERVER = "https://streamdrop.app"

function getDefaultServer() {
  if (Bun.env.STREAMDROP_SERVER) return Bun.env.STREAMDROP_SERVER
  try {
    const rc = readFileSync(join(homedir(), ".streamdroprc"), "utf-8")
    const match = rc.match(/SERVER=(.*)/)
    if (match && match[1]) return match[1].trim()
  } catch {}
  return DEFAULT_SERVER
}

const argv = Bun.argv.slice(2)
const cmd = argv[0]
let startTime = 0

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
  const server = getFlagValue("--server") ?? getDefaultServer()
  try {
    await runSend(server, filePath)
  } catch (err: any) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
} else {
  const input = argv[1]
  if (!input) {
    printHelp()
    process.exit(1)
  }
  const overrideServer = getFlagValue("--server") ?? getDefaultServer()
  try {
    await runReceive(input, overrideServer)
  } catch (err: any) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
}

function printHelp() {
  console.log(`streamdrop

Usage:
  streamdrop send <file_or_folder> [--server <url>]
  streamdrop receive <share-url> [--server <url>] [--out <file>] [--no-extract]

Environment:
  STREAMDROP_SERVER

Config File (~/.streamdroprc):
  SERVER=https://my-server.com

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

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function printProgress(action: string, current: number, total?: number) {
  if (!startTime) startTime = Date.now()
  const elapsed = (Date.now() - startTime) / 1000
  const speed = elapsed > 0 ? current / elapsed : 0
  const speedStr = `${formatBytes(speed)}/s`

  if (total) {
    const percent = ((current / total) * 100).toFixed(1)
    const eta = speed > 0 ? Math.round((total - current) / speed) : 0
    const etaStr = eta > 0 ? `${eta}s left` : ""
    process.stdout.write(`\r\x1b[K${action}: ${formatBytes(current)} / ${formatBytes(total)} (${percent}%) | ${speedStr} | ${etaStr}`)
  } else {
    process.stdout.write(`\r\x1b[K${action}: ${formatBytes(current)} | ${speedStr}`)
  }
}

async function runSend(serverRaw: string, filePath: string) {
  const server = normalizeServer(serverRaw)
  if (!existsSync(filePath)) throw new Error("file_not_found")
  
  const file = Bun.file(filePath)
  const stat = await statFs(filePath)

  let fileName = basename(filePath)
  let totalSize: number | undefined
  if (stat.isDirectory()) {
    fileName = `${fileName}.sd-dir.tar`
    console.log(`Directory detected. Archiving on the fly...`)
  } else {
    totalSize = stat.size
  }

  const sess = (await fetchJson(`${server}/session?name=${encodeURIComponent(fileName)}&size=${totalSize || ""}`, { method: "POST" })) as SessionRes
  if (!sess?.id || !sess.uploadToken || !sess.downloadToken) throw new Error("session_failed")

  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const keyFrag = base64urlEncode(rawKey)
  const shareUrl = `${server}/${sess.id}#${keyFrag},${encodeURIComponent(fileName)}`
  const receiveCode = `${sess.id}:${keyFrag}:${encodeURIComponent(fileName)}`

  console.log(`Share URL: ${shareUrl}`)
  if (server === DEFAULT_SERVER) {
    console.log(`Receive: streamdrop receive ${receiveCode}`)
  } else {
    console.log(`Receive: streamdrop receive ${receiveCode} --server ${server}`)
  }
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
      
      console.log(`\nReceiver connected. Starting upload...`)
      startTime = 0 // reset progress timer
      
      let streamToRead: ReadableStream<Uint8Array>
      if (stat.isDirectory()) {
        const tar = Bun.spawn(["tar", "-cf", "-", basename(filePath)], {
          cwd: dirname(filePath),
          stdout: "pipe",
        })
        streamToRead = tar.stdout
      } else {
        streamToRead = file.stream()
      }

      const enc = createEncryptStream({ 
        stream: streamToRead, 
        size: totalSize,
        key, 
        sessionId: sess.id, 
        onProgress: (sent: number, total: number) => printProgress("Uploading", sent, total)
      })
      
      const res = await fetch(`${server}/upload/${sess.uploadToken}/${encodeURIComponent(channelId)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: enc,
        duplex: "half",
      } as any)
      
      console.log() // New line after progress
      if (!res.ok) {
        const t = await safeText(res)
        console.error(`upload_failed: ${t || res.status}`)
      } else {
        console.log(`Upload complete.`)
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

  const outFlag = getFlagValue("--out")
  const noExtract = argv.includes("--no-extract")

  let outName = safeOutName(parsed.fileName || cfg.fileName || "streamdrop.bin")
  
  const isAutoTar = outName.endsWith(".sd-dir.tar")
  const shouldExtract = isAutoTar && !outFlag && !noExtract

  if (isAutoTar && !shouldExtract && !outFlag) {
    outName = outName.replace(".sd-dir.tar", ".tar")
  }

  let outPath = outFlag ? outFlag : `./${outName}`

  if (!outFlag && existsSync(outPath)) {
    const ext = extname(outPath)
    const base = basename(outPath, ext)
    const dir = dirname(outPath)
    let counter = 1
    while (existsSync(outPath)) {
      outPath = join(dir, `${base} (${counter})${ext}`)
      counter++
    }
  }

  console.log(`Connecting to ${server}...`)
  const res = await fetch(`${server}/d/${downloadToken}`, { method: "GET", headers: { accept: "application/octet-stream" } })
  if (!res.ok || !res.body) throw new Error(`download_failed_${res.status}`)

  console.log(`Downloading to ${outPath}...`)
  startTime = 0 // reset progress timer
  const decrypt = createDecryptTransform({ 
    key, 
    sessionId: parsed.id, 
    onProgress: (received: number) => printProgress("Downloading", received) 
  })
  
  const plain = res.body.pipeThrough(decrypt)
  
  if (shouldExtract) {
    console.log(`Folder archive detected. Extracting on the fly...`)
    const tarProc = Bun.spawn(["tar", "-xf", "-"], {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    })

    const writer = new WritableStream({
      write(chunk) {
        tarProc.stdin.write(chunk)
      },
      close() {
        tarProc.stdin.end()
      },
    })

    await plain.pipeTo(writer)
    await tarProc.exited

    console.log() // New line after progress
    console.log(`Extracted successfully.`)
  } else {
    await writeToFile(outPath, plain)
    
    console.log() // New line after progress
    console.log(`Saved: ${outPath}`)
  }
}

function parseShareInput(input: string): { server?: string; id: string; keyFrag: string; fileName?: string } {
  const s = input.trim()
  
  if (!s.startsWith("http://") && !s.startsWith("https://") && s.includes(":")) {
    const parts = s.split(":")
    const id = parts[0]
    const keyFrag = parts[1]
    let fileName: string | undefined
    if (parts.length > 2) {
      try {
        fileName = decodeURIComponent(parts.slice(2).join(":"))
      } catch {
        fileName = parts.slice(2).join(":")
      }
    }
    if (!id) throw new Error("missing_id")
    if (!keyFrag) throw new Error("missing_key")
    return { id, keyFrag, fileName }
  }

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
  if (!res.ok) {
    if (res.status === 404) throw new Error("File session not found or has expired.")
    throw new Error(`Failed to fetch session: HTTP ${res.status}`)
  }
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
