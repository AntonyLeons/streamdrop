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
    const channelId = await claimChannelId(base, cfg.uploadToken)
    expect(channelId).toBeTruthy()

    const payload = new TextEncoder().encode("hello-streamdrop")
    const uploadRes = await fetch(`${base}/upload/${cfg.uploadToken}/${channelId}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    })
    expect(uploadRes.status).toBe(200)
    const downloadRes = await downloadResP
    const got = new Uint8Array(await downloadRes.arrayBuffer())
    expect(Buffer.from(got)).toEqual(Buffer.from(payload))
  } finally {
    server.stop(true)
  }
})

test("raw receiver-first relay pipes bytes and returns .bin filename", async () => {
  const app = createApp()
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const base = `http://localhost:${server.port}`

  try {
    const html = await fetch(`${base}/`).then((r) => r.text())
    const cfg = extractCfg(html)

    const downloadResP = fetch(`${base}/raw/d/${cfg.downloadToken}`)
    const channelId = await claimChannelId(base, cfg.uploadToken)
    expect(channelId).toBeTruthy()

    const payload = new TextEncoder().encode("hello-raw")
    const uploadRes = await fetch(`${base}/raw/upload/${cfg.uploadToken}/${channelId}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: payload,
    })
    expect(uploadRes.status).toBe(200)
    const downloadRes = await downloadResP
    expect(downloadRes.status).toBe(200)
    expect(downloadRes.headers.get("content-disposition")).toContain('filename="streamdrop.bin"')
    const got = new Uint8Array(await downloadRes.arrayBuffer())
    expect(Buffer.from(got)).toEqual(Buffer.from(payload))
  } finally {
    server.stop(true)
  }
})

test("xfr endpoints expose human links and redirect upload to a trailing-slash URL", async () => {
  const app = createApp()
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const base = `http://localhost:${server.port}`

  try {
    const txt = await fetch(`${base}/xfr`).then((r) => r.text())
    expect(txt).toContain("human-transfer-url:")
    expect(txt).toContain("human-recv-url:")

    const res = await fetch(`${base}/xfr`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
      redirect: "manual",
    })
    expect(res.status).toBe(307)
    const loc = res.headers.get("location") || ""
    expect(loc).toMatch(new RegExp(`^${base}/xfr/[A-Za-z0-9_-]+/$`))
  } finally {
    server.stop(true)
  }
})

test("GET /d/:token returns 429 when receiver limit is reached", async () => {
  const old = Bun.env.MAX_RECEIVERS
  Bun.env.MAX_RECEIVERS = "25"
  const app = createApp()
  try {
    const sessionRes = await app.request("/")
    const html = await sessionRes.text()
    const cfg = extractCfg(html)

    const pending: Promise<Response>[] = []
    const controllers: AbortController[] = []
    const max = getMaxReceivers()
    for (let i = 0; i < max; i++) {
      const ac = new AbortController()
      controllers.push(ac)
      pending.push(app.request(`/d/${cfg.downloadToken}`, { signal: ac.signal }) as Promise<Response>)
    }
    await sleep(20)

    const limitRes = await app.request(`/d/${cfg.downloadToken}`)
    expect(limitRes.status).toBe(429)
    expect(await limitRes.json()).toEqual({ error: "too_many_receivers" })

    for (const ac of controllers) ac.abort()
    await Promise.allSettled(pending)
  } finally {
    if (old === undefined) delete Bun.env.MAX_RECEIVERS
    else Bun.env.MAX_RECEIVERS = old
  }
})

test("receiver-first relay supports multiple sequential downloads (re-stream)", async () => {
  const app = createApp()
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const base = `http://localhost:${server.port}`

  try {
    const html = await fetch(`${base}/`).then((r) => r.text())
    const cfg = extractCfg(html)

    const download1P = fetch(`${base}/d/${cfg.downloadToken}`)
    const ch1 = await claimChannelId(base, cfg.uploadToken)
    expect(ch1).toBeTruthy()

    const payload1 = new TextEncoder().encode("cycle1")
    const upload1 = await fetch(`${base}/upload/${cfg.uploadToken}/${ch1}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: payload1,
    })
    expect(upload1.status).toBe(200)
    const download1 = await download1P
    expect(Buffer.from(new Uint8Array(await download1.arrayBuffer()))).toEqual(Buffer.from(payload1))

    const download2P = fetch(`${base}/d/${cfg.downloadToken}`)
    const ch2 = await claimChannelId(base, cfg.uploadToken)
    expect(ch2).toBeTruthy()

    const payload2 = new TextEncoder().encode("cycle2")
    const upload2 = await fetch(`${base}/upload/${cfg.uploadToken}/${ch2}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: payload2,
    })
    expect(upload2.status).toBe(200)
    const download2 = await download2P
    expect(Buffer.from(new Uint8Array(await download2.arrayBuffer()))).toEqual(Buffer.from(payload2))
  } finally {
    server.stop(true)
  }
})

async function claimChannelId(base: string, uploadToken: string) {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/claim/${uploadToken}`, { method: "POST", headers: { accept: "application/json" } })
    if (res.status === 204) {
      await sleep(10)
      continue
    }
    if (!res.ok) throw new Error(`claim_failed_${res.status}`)
    const body = (await res.json()) as any
    if (body && typeof body.channelId === "string") return body.channelId
    throw new Error("claim_bad_body")
  }
  throw new Error("claim_timeout")
}
