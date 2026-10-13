import { createApp } from "../../src/app"
import { MAX_REQUEST_BODY_SIZE } from "../../src/server-config"

const sizeMiB = Number(Bun.env.TRANSFER_MIB ?? "256")
const totalBytes = sizeMiB * 1024 * 1024
const chunkBytes = 64 * 1024
const app = createApp()
const server = Bun.serve({
  port: 0,
  fetch: app.fetch,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
})
const base = `http://127.0.0.1:${server.port}`
let peakRss = process.memoryUsage.rss()
const memorySampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss())
}, 5)

try {
  const cfg = await fetch(`${base}/`, {
    headers: { accept: "application/json" },
  }).then((response) => response.json()) as {
    uploadToken: string
    downloadToken: string
  }

  const downloadPromise = fetch(`${base}/raw/d/${cfg.downloadToken}`)
  const channelId = await claimChannel(base, cfg.uploadToken)
  let produced = 0
  const uploadBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      const remaining = totalBytes - produced
      if (remaining <= 0) {
        controller.close()
        return
      }
      const length = Math.min(chunkBytes, remaining)
      controller.enqueue(new Uint8Array(length))
      produced += length
    },
  })

  const cpuBefore = process.cpuUsage()
  const started = Bun.nanoseconds()
  const uploadPromise = fetch(`${base}/raw/upload/${cfg.uploadToken}/${channelId}`, {
    method: "PUT",
    body: uploadBody,
  })
  const download = await downloadPromise
  if (!download.ok || !download.body) throw new Error(`download_${download.status}`)

  const reader = download.body.getReader()
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
  }

  const upload = await uploadPromise
  if (!upload.ok) throw new Error(`upload_${upload.status}`)
  const elapsedSeconds = (Bun.nanoseconds() - started) / 1e9
  const cpu = process.cpuUsage(cpuBefore)
  peakRss = Math.max(peakRss, process.memoryUsage.rss())

  if (received !== totalBytes) {
    throw new Error(`byte_count_mismatch:${received}:${totalBytes}`)
  }

  console.log(JSON.stringify({
    sizeMiB,
    received,
    elapsedSeconds,
    throughputMiBs: sizeMiB / elapsedSeconds,
    peakRssMiB: peakRss / 1024 / 1024,
    cpuSeconds: (cpu.user + cpu.system) / 1e6,
  }))
} finally {
  clearInterval(memorySampler)
  server.stop(true)
}

async function claimChannel(base: string, uploadToken: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/claim/${uploadToken}`, { method: "POST" })
    if (response.status === 204) {
      await Bun.sleep(5)
      continue
    }
    if (!response.ok) throw new Error(`claim_${response.status}`)
    const body = await response.json() as { channelId?: string }
    if (body.channelId) return body.channelId
  }
  throw new Error("claim_timeout")
}
