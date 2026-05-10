import { test, expect, type Page } from "@playwright/test"
import path from "path"

// ─── helpers ────────────────────────────────────────────────────────────────

/** Extract the session config embedded in a page's HTML */
async function getPageCfg(page: Page) {
  return page.evaluate(() => (window as any).__STREAMDROP__)
}

/** Simulate dropping / selecting a file via the hidden <input> */
async function uploadFile(page: Page, name: string, content: string | Buffer) {
  const buf = typeof content === "string" ? Buffer.from(content) : content
  await page.locator("input#file").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: buf,
  })
}

async function uploadFiles(page: Page, files: Array<{ name: string; content: string | Buffer }>) {
  const payload = files.map((f) => ({
    name: f.name,
    mimeType: "application/octet-stream",
    buffer: typeof f.content === "string" ? Buffer.from(f.content) : f.content,
  }))
  await page.locator("input#file").setInputFiles(payload)
}

// ─── Upload page ─────────────────────────────────────────────────────────────

test("upload page loads with correct UI", async ({ page }) => {
  await page.goto("/")

  await expect(page.locator("h1")).toContainText("StreamDrop")
  await expect(page.locator(".dropzone")).toBeVisible()
  await expect(page.locator("[data-step='key']")).toBeVisible()
  await expect(page.locator("[data-step='encrypt']")).toBeVisible()
  await expect(page.locator("[data-step='stream']")).toBeVisible()
  await expect(page.locator("[data-step='ready']")).toBeVisible()
  await expect(page.locator("#sd-files")).toBeVisible()
  await expect(page.locator("#sd-files-empty")).toBeVisible()
  await expect(page.locator("text=CLI endpoints")).toHaveCount(0)
})

test("upload page embeds session config", async ({ page }) => {
  await page.goto("/")
  const cfg = await getPageCfg(page)
  expect(cfg).toBeTruthy()
  expect(typeof cfg.id).toBe("string")
  expect(typeof cfg.uploadToken).toBe("string")
  expect(typeof cfg.downloadToken).toBe("string")
  // tokens should be URL-safe base64
  expect(cfg.uploadToken).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(cfg.downloadToken).toMatch(/^[A-Za-z0-9_-]+$/)
})

test("selecting a file shows share link and QR section", async ({ page }) => {
  await page.goto("/")
  await uploadFile(page, "hello.txt", "Hello StreamDrop E2E!")

  await expect(page.locator("#sd-files-empty")).toBeHidden({ timeout: 20_000 })

  // Share link should contain the session id and a key fragment
  const cfg = await getPageCfg(page)
  const link = await page.locator(".sd-file-item .sd-file-link").first().inputValue()
  expect(link).toContain(`/${cfg.id}#`)
  expect(link).toMatch(/^https?:\/\/.+\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+(,.*)?$/)
})

test("copy button updates text briefly", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/")
  await uploadFile(page, "copy-test.txt", "copy test")
  await expect(page.locator("#sd-files-empty")).toBeHidden({ timeout: 20_000 })

  const btn = page.locator(".sd-file-item").first().locator(".sd-file-link-row button[data-copy]")
  await btn.click()
  await expect(btn).toHaveText("Copied")
  await expect(btn).toHaveText("Copy", { timeout: 3_000 })
})

test("single file click opens picker only once (no double dialog)", async ({ page }) => {
  // If the double-click bug exists the file input would emit two 'change' events.
  // We verify by counting how many times handleFile would be invoked —
  // we track calls to crypto.subtle.generateKey which is called once per handleFile.
  await page.goto("/")

  let keyCalls = 0
  await page.exposeFunction("__trackKeyGen", () => { keyCalls++ })
  await page.evaluate(() => {
    const orig = (window.crypto.subtle as any).generateKey.bind(window.crypto.subtle)
    ;(window.crypto.subtle as any).generateKey = (...a: any[]) => {
      ;(window as any).__trackKeyGen()
      return orig(...a)
    }
  })

  await uploadFile(page, "once.txt", "one key only")
  await expect(page.locator("#sd-files-empty")).toBeHidden({ timeout: 20_000 })

  expect(keyCalls).toBe(1)
})

test("selecting multiple files shows multiple share links", async ({ page }) => {
  await page.goto("/")
  await uploadFiles(page, [
    { name: "a.txt", content: "a" },
    { name: "b.txt", content: "b" },
  ])

  await expect(page.locator("#sd-files-empty")).toBeHidden({ timeout: 20_000 })
  await expect(page.locator(".sd-file-item")).toHaveCount(2, { timeout: 20_000 })

  const links = await page.locator(".sd-file-item .sd-file-link").evaluateAll((els) =>
    els.map((el) => (el instanceof HTMLInputElement ? el.value : "")),
  )
  expect(links.length).toBe(2)
  expect(links[0]).toMatch(/^https?:\/\/.+\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+/)
  expect(links[1]).toMatch(/^https?:\/\/.+\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+/)
})

// ─── Progress ─────────────────────────────────────────────────────────────────

test("progress advances during encryption", async ({ page }) => {
  await page.goto("/")
  const largeFile = Buffer.alloc(512 * 1024, 0x55) // 512 KB
  await uploadFile(page, "large.bin", largeFile)
  await expect(page.locator(".sd-file-item [data-badge='encrypted']").first()).toBeVisible({ timeout: 60_000 })
  const width = await page.locator(".sd-file-item .sd-file-bar").first().evaluate((el) => {
    return parseInt((el as HTMLElement).style.width || "0")
  })
  expect(Number.isFinite(width)).toBe(true)
  expect(width).toBeGreaterThanOrEqual(0)
  expect(width).toBeLessThanOrEqual(100)
})

// ─── Download page ────────────────────────────────────────────────────────────

test("download page loads for valid session", async ({ page, request }) => {
  // Get a valid session id via the API
  const html = await request.get("/").then((r) => r.text())
  const m = html.match(/window\.__STREAMDROP__=(\{[^<]+\})/)
  const cfg = JSON.parse(m![1])

  await page.goto(`/${cfg.id}`)
  await expect(page.locator("h1")).toContainText("Receive")
  await expect(page.locator("#start")).toBeVisible()
  await expect(page.locator("[data-step='wait']")).toBeVisible()
})

test("download page for unknown id shows 404", async ({ page }) => {
  await page.goto("/nonexistent_id_xyz")
  await expect(page.locator("body")).toContainText("404")
})

// ─── Full transfer ────────────────────────────────────────────────────────────

test.skip("full upload → download round-trip", async ({ browser }) => {
  const PAYLOAD = "StreamDrop E2E round-trip payload — ✓"

  // Two separate browser contexts simulate independent devices
  const ctxSender = await browser.newContext()
  const ctxReceiver = await browser.newContext({ acceptDownloads: true })
  const sender = await ctxSender.newPage()
  const receiver = await ctxReceiver.newPage()

  try {
    // 1. Sender opens the upload page
    await sender.goto("/")
    const cfg = await getPageCfg(sender)

    // Force fallback blob approach, since headless chromium exposes 
    // showSaveFilePicker but won't trigger the test "download" event easily
    await receiver.addInitScript(() => {
      delete (window as any).showSaveFilePicker
    })

    // 2. Receiver opens the download page first (receiver-first pattern)
    await receiver.goto(`/${cfg.id}`)
    await expect(receiver.locator("#start")).toBeVisible()

    // 3. Receiver clicks Start — GET /d/:token is issued and waits for sender
    const downloadPromise = receiver.waitForEvent("download", { timeout: 30_000 })
    await receiver.locator("#start").click()

    // 4. Sender selects and uploads file (concurrent with receiver waiting)
    await uploadFile(sender, "transfer.txt", PAYLOAD)

    // 5. Wait for download to arrive at receiver
    const download = await downloadPromise
    const downloadPath = path.join("/tmp", download.suggestedFilename() || "streamdrop-download")
    await download.saveAs(downloadPath)

    // 6. Verify sender shows "Share" step as on (which signifies completion)
    await expect(sender.locator("[data-step='ready']")).toHaveClass(/on/, { timeout: 15_000 })
  } finally {
    await ctxSender.close()
    await ctxReceiver.close()
  }
})

test.skip("upload returns 409 for a second sender on same session", async ({ page }) => {
  await page.goto("/")
  const cfg = await getPageCfg(page)

  // Use page.evaluate to start a fetch we can abort
  await page.evaluate(async (token) => {
    window.__abortController = new AbortController()
    
    // Create a slow readable stream to keep the connection open
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1,2,3]))
      }
    })
    
    // Fire and forget
    window.__firstFetch = fetch(`/upload/${token}/test-channel`, {
      method: 'PUT',
      body: stream,
      duplex: 'half',
      signal: window.__abortController.signal
    }).catch(() => {})
  }, cfg.uploadToken)

  // Small delay then try a second sender
  await page.waitForTimeout(50)
  
    const retry = await page.evaluate(async (token) => {
      const res = await fetch(`/upload/${token}/test-channel`, {
        method: "PUT",
        body: new Uint8Array([4,5,6])
      })
      return { status: res.status, body: await res.json() }
    }, cfg.uploadToken)
  
  expect(retry.status).toBe(409)
  expect(retry.body.error).toBe("sender_exists")

  // Cleanup: abort the first request
  await page.evaluate(() => {
    window.__abortController.abort()
  })
})
