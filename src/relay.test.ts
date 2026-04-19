import { expect, test } from "bun:test"
import { createApp } from "./app"
import { createSession, getMaxReceivers } from "./sessions"

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function extractCfg(html: string) {
  const json = html.match(/window\.__STREAMDROP__=(\{[^<]+\})<\/script>/)?.[1]
  return JSON.parse(json!)
}

test("receiver-first relay pipes bytes from upload to download", async () => {
  const app = createApp()
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const base = `http://localhost:${server.port}`

  try {
    const html = await fetch(`${base}/`).then((r) => r.text())
    const cfg = extractCfg(html)

    const downloadResP = fetch(`${base}/d/${cfg.downloadToken}`)
    await sleep(20)

    const payload = new TextEncoder().encode("hello-streamdrop")
    const uploadRes = await fetch(`${base}/upload/${cfg.uploadToken}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    })
    expect(uploadRes.status).toBe(200)

    const downloadRes = await downloadResP
    expect(downloadRes.status).toBe(200)
    const got = new Uint8Array(await downloadRes.arrayBuffer())
    expect(Buffer.from(got)).toEqual(Buffer.from(payload))
  } finally {
    server.stop(true)
  }
})

test("GET /d/:token returns 429 when receiver limit is reached", async () => {
  const app = createApp()
  const sessionRes = await app.request("/")
  const html = await sessionRes.text()
  const cfg = extractCfg(html)

  const pending: Promise<Response>[] = []
  const max = getMaxReceivers()
  for (let i = 0; i < max; i++) {
    pending.push(app.request(`/d/${cfg.downloadToken}`) as Promise<Response>)
  }
  await sleep(20)

  const limitRes = await app.request(`/d/${cfg.downloadToken}`)
  expect(limitRes.status).toBe(429)
  expect(await limitRes.json()).toEqual({ error: "too_many_receivers" })

  app.request(`/upload/${cfg.uploadToken}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([0]),
  })
  await Promise.allSettled(pending)
})

test("upload returns 409 when session is already done", async () => {
  const app = createApp()
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const base = `http://localhost:${server.port}`

  try {
    const html = await fetch(`${base}/`).then((r) => r.text())
    const cfg = extractCfg(html)

    const downloadResP = fetch(`${base}/d/${cfg.downloadToken}`)
    await sleep(20)

    await fetch(`${base}/upload/${cfg.uploadToken}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new TextEncoder().encode("done-cycle"),
    })

    await downloadResP

    const retry = await fetch(`${base}/upload/${cfg.uploadToken}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new TextEncoder().encode("retry"),
    })
    expect(retry.status).toBe(409)
    expect(await retry.json()).toEqual({ error: "done" })
  } finally {
    server.stop(true)
  }
})

test("download returns 410 when session is already done", async () => {
  const app = createApp()
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const base = `http://localhost:${server.port}`

  try {
    const html = await fetch(`${base}/`).then((r) => r.text())
    const cfg = extractCfg(html)

    const downloadResP = fetch(`${base}/d/${cfg.downloadToken}`)
    await sleep(20)

    await fetch(`${base}/upload/${cfg.uploadToken}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new TextEncoder().encode("done"),
    })

    await downloadResP
    await sleep(10)

    const retry = await fetch(`${base}/d/${cfg.downloadToken}`)
    expect(retry.status).toBe(410)
    expect(await retry.json()).toEqual({ error: "done" })
  } finally {
    server.stop(true)
  }
})
