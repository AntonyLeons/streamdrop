import QRCode from "qrcode"
import { createDecryptTransform, createEncryptStream } from "../public/static/crypto.js"
import { basename, extname, dirname, join } from "node:path"
import { existsSync, readFileSync, createReadStream, createWriteStream, mkdirSync } from "node:fs"
import { stat as statFs } from "node:fs/promises"
import { homedir } from "node:os"
import * as tar from "tar"
import { Readable, Writable, PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import pkg from "./package.json"
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } from "werift"


type SessionRes = { id: string; uploadToken: string; downloadToken: string }

const DEFAULT_SERVER = "https://streamdrop.app"

function getDefaultServer() {
  if (process.env.STREAMDROP_SERVER) return process.env.STREAMDROP_SERVER
  try {
    const rc = readFileSync(join(homedir(), ".streamdroprc"), "utf-8")
    const match = rc.match(/SERVER=(.*)/)
    if (match && match[1]) return match[1].trim()
  } catch {}
  return DEFAULT_SERVER
}

const argv = process.argv.slice(2)
const cmd = argv[0]
let startTime = 0

process.on("uncaughtException", (err) => {
  console.error(`\nError: ${err.message || err}`)
  process.exit(1)
})

process.on("unhandledRejection", (reason: any) => {
  console.error(`\nError: ${reason?.message || reason}`)
  process.exit(1)
})

process.on("SIGINT", () => {
  console.log("\n\n\x1b[31mTransfer cancelled.\x1b[0m")
  process.exit(0)
})

if (cmd === "-v" || cmd === "--version") {
  console.log(pkg.version)
  process.exit(0)
}

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
    if (err.name === "AbortError") {
      console.error(`\nError: Aborted`)
    } else {
      console.error(`\nError: ${err.message}`)
    }
    process.exit(1)
  }
}

function printHelp() {
  console.log(`streamdrop

Usage:
  streamdrop send <file_or_folder> [--server <url>] [--qr]
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
  if (!v || v.startsWith("-")) return null
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
  
  const stat = await statFs(filePath)

  let fileName = basename(filePath)
  let totalSize: number | undefined
  if (stat.isDirectory()) {
    fileName = `${fileName}.sd-dir.tar`
    console.log(`Directory detected. Archiving on the fly...`)
  } else {
    totalSize = stat.size
  }

  const sess = (await fetchJson(`${server}/session`, { method: "POST" })) as SessionRes
  if (!sess?.id || !sess.uploadToken || !sess.downloadToken) throw new Error("session_failed")

  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const keyFrag = base64urlEncode(rawKey)
  const sizeSegment = totalSize ? `,${totalSize}` : ""
  const shareUrl = `${server}/${sess.id}#${keyFrag},${encodeURIComponent(fileName)}${sizeSegment}`
  const receiveCode = `${sess.id}:${keyFrag}:${encodeURIComponent(fileName)}`

  console.log(`\n  \x1b[1mShare URL:\x1b[0m \x1b[36m${shareUrl}\x1b[0m`)
  if (server === DEFAULT_SERVER) {
    console.log(`  \x1b[1mReceive:\x1b[0m   \x1b[33mstreamdrop receive ${receiveCode}\x1b[0m\n`)
  } else {
    console.log(`  \x1b[1mReceive:\x1b[0m   \x1b[33mstreamdrop receive ${receiveCode} --server ${server}\x1b[0m\n`)
  }
  if (argv.includes("--qr")) {
    try {
      const qr = await QRCode.toString(shareUrl, { type: "terminal", small: false })
      console.log(qr.trimEnd() + "\n")
    } catch {}
  }

  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"])

  console.log(`\x1b[33mWaiting for receiver...\x1b[0m\n`)

  const sseUrl = `${server}/session/events/${sess.uploadToken}`
  const sseRes = await fetch(sseUrl)
  if (!sseRes.ok) throw new Error(`Events stream connection failed: ${sseRes.status}`)
  if (!sseRes.body) throw new Error("Events stream returned empty body")

  const reader = Readable.from(sseRes.body as any)
  const rl = createInterface({ input: reader, crlfDelay: Infinity })

  let pc: RTCPeerConnection | null = null
  let currentEvent = ""
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim()
    } else if (trimmed.startsWith("data:")) {
      const dataStr = trimmed.slice(5).trim()
      let data: any = null
      try {
        data = JSON.parse(dataStr)
      } catch {}

      if (currentEvent === "signal" && data) {
        if (data.type === "offer") {
          if (pc) {
            try { pc.close() } catch {}
            pc = null
          }

          console.log(`\x1b[36mDirect P2P offer received. Connecting...\x1b[0m`)

          const isLocal = server.includes("localhost") || server.includes("127.0.0.1") || server.includes("[::1]")
          pc = new RTCPeerConnection({
            iceServers: isLocal ? [] : [{ urls: "stun:stun.l.google.com:19302" }]
          })

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              fetch(`${server}/session/signal/${sess.uploadToken}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ type: "candidate", candidate: event.candidate })
              }).catch(() => {})
            }
          }

          const localPc = pc
          pc.ondatachannel = (event) => {
            const channel = event.channel
            channel.binaryType = "arraybuffer"

            let ackReceived = false
            let resolveAck: (() => void) | undefined

            channel.onmessage = (e: any) => {
              let isAck = false
              if (typeof e.data === "string" && e.data === "ACK") {
                isAck = true
              } else if (e.data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(e.data)
                if (bytes.length === 3 && bytes[0] === 0x41 && bytes[1] === 0x43 && bytes[2] === 0x4b) {
                  isAck = true
                }
              }
              if (isAck) {
                ackReceived = true
                if (resolveAck) {
                  resolveAck()
                }
              }
            }

            channel.onopen = async () => {
              console.log(`\n\x1b[32mReceiver connected (P2P). Starting upload...\x1b[0m`)
              startTime = 0

              let streamToRead: ReadableStream<Uint8Array>
              if (stat.isDirectory()) {
                const nodeStream = tar.c({
                  cwd: dirname(filePath),
                  portable: true,
                }, [basename(filePath)])
                const pass = new PassThrough()
                nodeStream.pipe(pass)
                streamToRead = Readable.toWeb(pass) as ReadableStream<Uint8Array>
              } else {
                streamToRead = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
              }

              const enc = createEncryptStream({
                stream: streamToRead,
                size: totalSize,
                key,
                sessionId: sess.id,
                chunkSize: 16 * 1024, // 16 KB chunks for high compatibility with browser P2P data channels
                onProgress: (sent: number, total: number) => printProgress("Uploading (P2P)", sent, total)
              })

              const reader = enc.getReader()
              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) {
                    if (channel.readyState === "open") {
                      channel.send("EOF")
                    }
                    break
                  }

                  if (channel.readyState !== "open") {
                    throw new Error("P2P data channel closed during transmission")
                  }

                  channel.send(value)

                  if (channel.bufferedAmount > 1024 * 1024) {
                    await new Promise<void>((resolve, reject) => {
                      const onBufferedAmountLow = () => {
                        channel.onbufferedamountlow = undefined
                        resolve()
                      }
                      const onClose = () => {
                        reject(new Error("P2P data channel closed during backpressure wait"))
                      }
                      channel.onbufferedamountlow = onBufferedAmountLow
                      channel.onclose = onClose

                      // Safety timeout (10s)
                      setTimeout(() => {
                        if (channel.onbufferedamountlow === onBufferedAmountLow) {
                          channel.onbufferedamountlow = undefined
                          resolve()
                        }
                      }, 10000)
                    })
                  }
                }

                console.log()
                console.log(`\x1b[32mUpload complete.\x1b[0m\n`)

                // Wait for the data channel buffer to be completely empty
                if (channel.bufferedAmount > 0) {
                  await new Promise<void>((resolve) => {
                    const onBufferedAmountLow = () => {
                      channel.onbufferedamountlow = undefined
                      resolve()
                    }
                    channel.onbufferedamountlow = onBufferedAmountLow
                    channel.onclose = () => resolve()
                    setTimeout(resolve, 2000)
                  })
                }

                // Wait for the receiver's ACK message over the data channel
                if (!ackReceived && channel.readyState === "open") {
                  await new Promise<void>((resolve) => {
                    resolveAck = resolve
                    channel.onclose = () => resolve()
                    // 5-second safety timeout in case the receiver fails to ACK cleanly
                    setTimeout(resolve, 5000)
                  })
                }

                if (pc === localPc) {
                  try { localPc.close() } catch {}
                  pc = null
                } else {
                  try { localPc.close() } catch {}
                }
                console.log(`\x1b[33mWaiting for receiver...\x1b[0m\n`)
              } catch (err: any) {
                console.error(`\n\x1b[31mP2P Upload failed: ${err.message || err}\x1b[0m\n`)
                if (pc === localPc) {
                  try { localPc.close() } catch {}
                  pc = null
                } else {
                  try { localPc.close() } catch {}
                }
              }
            }
          }

          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp, data.type))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)

          try {
            await fetch(`${server}/session/signal/${sess.uploadToken}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(answer)
            })
          } catch {}
        } else if (data.type === "candidate" && data.candidate && pc) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
        }
      }

      if (currentEvent === "channel_created" && data?.channelId) {
        const channelId = data.channelId
        const claimed = await claim(server, sess.uploadToken, channelId)
        if (claimed) {
          console.log(`\x1b[32mReceiver connected. Starting upload...\x1b[0m`)
          startTime = 0
          
          let streamToRead: ReadableStream<Uint8Array>
          if (stat.isDirectory()) {
            const nodeStream = tar.c({
              cwd: dirname(filePath),
              portable: true,
            }, [basename(filePath)])
            const pass = new PassThrough()
            nodeStream.pipe(pass)
            streamToRead = Readable.toWeb(pass) as ReadableStream<Uint8Array>
          } else {
            streamToRead = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
          }

          const enc = createEncryptStream({ 
            stream: streamToRead, 
            size: totalSize,
            key, 
            sessionId: sess.id, 
            onProgress: (sent: number, total: number) => printProgress("Uploading", sent, total)
          })
          
          const uploadRes = await fetch(`${server}/upload/${sess.uploadToken}/${encodeURIComponent(channelId)}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: enc,
            duplex: "half",
          } as any)
          
          console.log()
          if (!uploadRes.ok) {
            const t = await safeText(uploadRes)
            console.error(`\x1b[31mUpload failed: ${t || uploadRes.status}\x1b[0m\n`)
          } else {
            console.log(`\x1b[32mUpload complete.\x1b[0m\n`)
          }
        }
      }
      currentEvent = ""
    }
  }
}

async function attemptP2PDownload(
  server: string,
  cfg: any,
  key: CryptoKey,
  outPath: string,
  sessionId: string,
  shouldExtract: boolean,
  outName: string,
  expectedSize: number
): Promise<boolean> {
  return new Promise<boolean>(async (resolve) => {
    let pc: RTCPeerConnection | null = null
    let sseReader: any = null
    let timeoutId: any = null
    let finished = false
    let rl: any = null
    const sseController = new AbortController()

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      if (pc) {
        try { pc.close() } catch {}
        pc = null
      }
      sseController.abort()
      if (rl) {
        try { rl.close() } catch {}
        rl = null
      }
      if (sseReader) {
        try { sseReader.cancel() } catch {}
        sseReader = null
      }
    }

    try {
      console.log(`\x1b[36mAttempting direct P2P connection...\x1b[0m`)

      const isLocal = server.includes("localhost") || server.includes("127.0.0.1") || server.includes("[::1]")
      pc = new RTCPeerConnection({
        iceServers: isLocal ? [] : [{ urls: "stun:stun.l.google.com:19302" }]
      })

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          fetch(`${server}/session/signal/${cfg.downloadToken}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "candidate", candidate: event.candidate })
          }).catch(() => {})
        }
      }

      const channel = pc.createDataChannel("file-transfer")
      channel.binaryType = "arraybuffer"

      const sseUrl = `${server}/session/events/${cfg.downloadToken}`
      const sseRes = await fetch(sseUrl, { signal: sseController.signal })
      if (!sseRes.ok) {
        cleanup()
        resolve(false)
        return
      }
      if (!sseRes.body) {
        cleanup()
        resolve(false)
        return
      }

      const reader = Readable.from(sseRes.body as any)
      reader.on("error", () => {}) // Prevent unhandled stream crashes on abort
      sseReader = reader
      rl = createInterface({ input: reader, crlfDelay: Infinity })

      // Listen for signals in background
      ;(async () => {
        let currentEvent = ""
        try {
          for await (const line of rl) {
            const trimmed = line.trim()
            if (!trimmed) continue
            if (trimmed.startsWith("event:")) {
              currentEvent = trimmed.slice(6).trim()
            } else if (trimmed.startsWith("data:")) {
              const dataStr = trimmed.slice(5).trim()
              let data: any = null
              try { data = JSON.parse(dataStr) } catch {}

              if (currentEvent === "signal" && data && pc) {
                if (data.type === "answer") {
                  await pc.setRemoteDescription(new RTCSessionDescription(data.sdp, data.type))
                } else if (data.type === "candidate" && data.candidate) {
                  await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
                }
              }
              currentEvent = ""
            }
          }
        } catch {}
      })()

      // Create offer
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      try {
        await fetch(`${server}/session/signal/${cfg.downloadToken}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: offer.type,
            sdp: offer.sdp,
            browser: "default"
          })
        })
      } catch {}

      // Connection timeout (5s)
      timeoutId = setTimeout(() => {
        if (!finished) {
          console.log(`\x1b[33mP2P connection timeout.\x1b[0m`)
          cleanup()
          resolve(false)
        }
      }, 5000)

      channel.onopen = async () => {
        if (finished) return
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }

        console.log(`\x1b[32mConnected (P2P). Downloading...\x1b[0m`)
        startTime = 0

        let plainBytes = 0
        const decrypt = createDecryptTransform({
          key,
          sessionId,
          onProgress: (received: number) => {
            plainBytes = received
            printProgress("Downloading", received)
          },
        })

        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
        const encryptedStream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
          }
        })

        channel.onmessage = (e: any) => {
          if (finished) return
          let isEof = false
          if (typeof e.data === "string" && e.data === "EOF") {
            isEof = true
          } else if (e.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(e.data)
            if (bytes.length === 3 && bytes[0] === 0x45 && bytes[1] === 0x4f && bytes[2] === 0x46) {
              isEof = true
            }
          }

          if (isEof) {
            try { streamController?.close() } catch {}
          } else {
            const buf = typeof e.data === "string" ? new TextEncoder().encode(e.data).buffer : e.data
            try { streamController?.enqueue(new Uint8Array(buf)) } catch {}
          }
        }

        channel.onerror = (err) => {
          try { streamController?.error(err) } catch {}
        }

        channel.onclose = () => {
          try { streamController?.close() } catch {}
        }

        const plain = encryptedStream.pipeThrough(decrypt)

        try {
          if (shouldExtract) {
            console.log(`Folder archive detected. Extracting on the fly...`)

            let extractDir = "."
            const folderName = outName.replace(".sd-dir.tar", "")
            const targetFolder = join(dirname(outPath), folderName)

            if (existsSync(targetFolder)) {
              let counter = 1
              let uniqueFolder = `${targetFolder} (${counter})`
              while (existsSync(uniqueFolder)) {
                counter++
                uniqueFolder = `${targetFolder} (${counter})`
              }
              mkdirSync(uniqueFolder, { recursive: true })
              extractDir = uniqueFolder
              console.log(`\n\x1b[33mFolder "${folderName}" already exists. Extracting inside safety folder "${basename(uniqueFolder)}/..." to prevent overwriting.\x1b[0m`)
            }

            const extractor = tar.x({ cwd: extractDir })
            const pass = new PassThrough()
            pass.pipe(extractor)

            await plain.pipeTo(Writable.toWeb(pass))

            if (plainBytes === 0 || (expectedSize > 0 && plainBytes !== expectedSize)) {
              throw new Error(`Incomplete transfer: received ${plainBytes} bytes, expected ${expectedSize} bytes`)
            }

            console.log()
            console.log(`\x1b[32mExtracted successfully.\x1b[0m\n`)
          } else {
            await writeToFile(outPath, plain)

            if (plainBytes === 0 || (expectedSize > 0 && plainBytes !== expectedSize)) {
              throw new Error(`Incomplete transfer: received ${plainBytes} bytes, expected ${expectedSize} bytes`)
            }

            console.log()
            console.log(`\x1b[32mSaved: ${outPath}\x1b[0m\n`)
          }
          if (channel.readyState === "open") {
            try { channel.send("ACK") } catch {}
          }
          finished = true
          cleanup()
          resolve(true)
        } catch (e: any) {
          console.error(`\n\x1b[31mP2P transfer error: ${e.message || e}\x1b[0m`)
          finished = true
          cleanup()
          resolve(false)
        }
      }
    } catch (err: any) {
      console.log(`\x1b[33mP2P negotiation failed: ${err.message || err}\x1b[0m`)
      finished = true
      cleanup()
      resolve(false)
    }
  })
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

  const expectedSize = typeof cfg.size === "number" ? cfg.size : (parseInt(cfg.size, 10) || 0)
  const p2pSuccess = await attemptP2PDownload(
    server,
    cfg,
    key,
    outPath,
    parsed.id,
    shouldExtract,
    outName,
    expectedSize
  )
  if (p2pSuccess) return

  console.log(`\x1b[33mP2P connection failed or timed out. Falling back to HTTP relay...\x1b[0m`)

  let attempt = 0
  while (true) {
    attempt++
    if (attempt > 1) {
      console.log(`\x1b[36mReconnecting... (${attempt})\x1b[0m`)
    } else {
      console.log(`\x1b[36mConnecting to ${server}...\x1b[0m`)
    }

    const { timeoutSignal, cleanup } = createFetchTimeout()
    let res: Response
    try {
      res = await fetch(`${server}/d/${downloadToken}`, {
        method: "GET",
        headers: { accept: "application/octet-stream" },
        signal: timeoutSignal,
      })
    } catch (err: any) {
      cleanup()
      if (isFatalNetworkError(err)) throw new Error(`Connection failed: ${err.message || err}`)
      await sleep(backoffMs(attempt))
      continue
    }

    if (!res.ok) {
      const errBody = await safeText(res)
      let err = ""
      try {
        const parsed = JSON.parse(errBody)
        if (parsed.error) err = parsed.error
      } catch {}
      if (!err) err = errBody

      cleanup()

      if (err === "done") {
        throw new Error("Transfer is finished. Ask the sender to start the transfer again.")
      }
      if (err === "not_found") {
        throw new Error("Session not found or has expired.")
      }
      if (err === "too_many_receivers" || isTransientHttpError(res.status)) {
        if (err === "too_many_receivers") {
          console.error(`\x1b[33mToo many receivers, waiting...\x1b[0m`)
        } else {
          console.error(`\x1b[33mServer ${res.status}, retrying...\x1b[0m`)
        }
        await sleep(backoffMs(attempt))
        continue
      }
      throw new Error(err || `download_failed_${res.status}`)
    }

    if (!res.body) {
      cleanup()
      await sleep(backoffMs(attempt))
      continue
    }

    console.log(`\x1b[36mDownloading to ${outPath}...\x1b[0m`)
    startTime = 0
    let plainBytes = 0
    const decrypt = createDecryptTransform({
      key,
      sessionId: parsed.id,
      onProgress: (received: number) => {
        plainBytes = received
        printProgress("Downloading", received)
      },
    })

    const plain = res.body.pipeThrough(decrypt)

    try {
      if (shouldExtract) {
        console.log(`Folder archive detected. Extracting on the fly...`)

        let extractDir = "."
        const folderName = outName.replace(".sd-dir.tar", "")
        const targetFolder = join(dirname(outPath), folderName)

        if (existsSync(targetFolder)) {
          let counter = 1
          let uniqueFolder = `${targetFolder} (${counter})`
          while (existsSync(uniqueFolder)) {
            counter++
            uniqueFolder = `${targetFolder} (${counter})`
          }
          mkdirSync(uniqueFolder, { recursive: true })
          extractDir = uniqueFolder
          console.log(`\n\x1b[33mFolder "${folderName}" already exists. Extracting inside safety folder "${basename(uniqueFolder)}/..." to prevent overwriting.\x1b[0m`)
        }

        const extractor = tar.x({
          cwd: extractDir,
        })
        const pass = new PassThrough()
        pass.pipe(extractor)

        await plain.pipeTo(Writable.toWeb(pass))

        const expectedSize = typeof cfg.size === "number" ? cfg.size : (parseInt(cfg.size, 10) || 0)
        if (plainBytes === 0 || (expectedSize > 0 && plainBytes !== expectedSize)) {
          throw new Error(`Incomplete transfer: received ${plainBytes} bytes, expected ${expectedSize} bytes`)
        }

        console.log()
        console.log(`\x1b[32mExtracted successfully.\x1b[0m\n`)
      } else {
        await writeToFile(outPath, plain)

        const expectedSize = typeof cfg.size === "number" ? cfg.size : (parseInt(cfg.size, 10) || 0)
        if (plainBytes === 0 || (expectedSize > 0 && plainBytes !== expectedSize)) {
          throw new Error(`Incomplete transfer: received ${plainBytes} bytes, expected ${expectedSize} bytes`)
        }

        console.log()
        console.log(`\x1b[32mSaved: ${outPath}\x1b[0m\n`)
      }
      cleanup()
      return
    } catch (e: any) {
      cleanup()
      const msg = String(e?.message ?? e ?? "")
      if (msg.includes("bad_magic") || msg.includes("bad_chunk_index") || msg.includes("OperationError")) {
        console.error(`\x1b[33mStream interrupted, reconnecting...\x1b[0m`)
        await sleep(backoffMs(attempt))
        continue
      }
      throw e
    }
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
  const fragParts = frag.split(",")
  const keyFrag = fragParts[0] ?? ""
  if (!keyFrag) throw new Error("missing_key")
  // Last segment may be a numeric byte-size appended by newer share links
  const lastPart = fragParts[fragParts.length - 1] ?? ""
  const hasSize = fragParts.length >= 3 && /^\d+$/.test(lastPart)
  const nameParts = hasSize ? fragParts.slice(1, -1) : fragParts.slice(1)

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
  const res = await fetch(`${server}/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } })
  if (!res.ok) {
    if (res.status === 404) throw new Error("File session not found or has expired.")
    throw new Error(`Failed to fetch session: HTTP ${res.status}`)
  }
  
  try {
    return (await res.json()) as any
  } catch {
    throw new Error("bad_cfg_json")
  }
}

async function fetchJson(url: string, init: RequestInit & { timeout?: number } = {}) {
  const userSignal = init.signal ?? undefined
  const { timeoutSignal, cleanup } = createFetchTimeout(userSignal)
  try {
    const res = await fetch(url, {
      ...init,
      signal: timeoutSignal,
      headers: { ...(init.headers || {}), accept: "application/json" },
    })
    if (!res.ok) {
      const t = await safeText(res)
      throw new Error(t || `http_${res.status}`)
    }
    return await res.json()
  } finally {
    cleanup()
  }
}

async function safeText(res: Response) {
  try {
    return await res.text()
  } catch {
    return ""
  }
}



async function claim(server: string, uploadToken: string, channelId?: string): Promise<string | null> {
  let attempt = 0
  while (true) {
    attempt++
    const { timeoutSignal, cleanup } = createFetchTimeout()
    try {
      const qs = channelId ? `?channelId=${encodeURIComponent(channelId)}` : ""
      const res = await fetch(`${server}/claim/${uploadToken}${qs}`, {
        method: "POST",
        headers: { accept: "application/json" },
        signal: timeoutSignal,
      })

      if (res.status === 204) return null
      if (res.status === 404) throw new Error("Session not found.")
      if (isTransientHttpError(res.status) || !res.ok) {
        await sleep(backoffMs(attempt))
        continue
      }

      const body = (await res.json().catch(() => null)) as any
      return typeof body?.channelId === "string" ? body.channelId : null
    } catch (err: any) {
      if (err.message === "Session not found.") throw err
      if (isFatalNetworkError(err)) {
        throw new Error(`Connection failed: ${err.message || err}`)
      }
      await sleep(backoffMs(attempt))
    } finally {
      cleanup()
    }
  }
}

async function writeToFile(path: string, stream: ReadableStream<Uint8Array>) {
  const w = createWriteStream(path)
  await stream.pipeTo(Writable.toWeb(w))
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function backoffMs(attempt: number) {
  return Math.min(10000, 250 * Math.pow(1.6, Math.max(0, attempt - 1)))
}

function createFetchTimeout(signal?: AbortSignal): { timeoutSignal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30000)

  const onParentAbort = () => {
    controller.abort()
    clearTimeout(timeoutId)
  }

  if (signal) {
    if (signal.aborted) {
      controller.abort()
      clearTimeout(timeoutId)
    } else {
      signal.addEventListener("abort", onParentAbort, { once: true })
    }
  }

  return {
    timeoutSignal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId)
      if (signal) signal.removeEventListener("abort", onParentAbort)
    },
  }
}

function isFatalNetworkError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return (
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("dns") ||
    msg.includes("getaddrinfo") ||
    msg.includes("protocol_error") ||
    msg.includes("invalid url") ||
    (msg.includes("abort") && !msg.includes("aborterror"))
  )
}

function isTransientHttpError(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}
