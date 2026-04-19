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

// ─── Upload page ─────────────────────────────────────────────────────────────

test("upload page loads with correct UI", async ({ page }) => {
  await page.goto("/")

  await expect(page.locator("h1")).toContainText("StreamDrop")
  await expect(page.locator(".dropzone")).toBeVisible()
  await expect(page.locator("[data-step='key']")).toBeVisible()
  await expect(page.locator("[data-step='encrypt']")).toBeVisible()
  await expect(page.locator("[data-step='upload']")).toBeVisible()
  await expect(page.locator("[data-step='ready']")).toBeVisible()
  await expect(page.locator("#share")).toBeHidden()
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

  // Share section should appear
  await expect(page.locator("#share")).toBeVisible({ timeout: 20_000 })

  // Share link should contain the session id and a key fragment
  const cfg = await getPageCfg(page)
  const link = await page.locator("#link").inputValue()
  expect(link).toContain(`/${cfg.id}#`)
  expect(link).toMatch(/^https?:\/\/.+\/[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/)
})

test("copy button updates text briefly", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/")
  await uploadFile(page, "copy-test.txt", "copy test")
  await expect(page.locator("#share")).toBeVisible({ timeout: 20_000 })

  await page.locator("#copy").click()
  await expect(page.locator("#copy")).toHaveText("Copied")
  await expect(page.locator("#copy")).toHaveText("Copy", { timeout: 3_000 })
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
  await expect(page.locator("#share")).toBeVisible({ timeout: 20_000 })

  expect(keyCalls).toBe(1)
})

// ─── Progress ─────────────────────────────────────────────────────────────────

test("progress bar advances during upload", async ({ page }) => {
  await page.goto("/")
  const largeFile = Buffer.alloc(512 * 1024, 0x55) // 512 KB
  await uploadFile(page, "large.bin", largeFile)
  // Bar should reach 100% after upload
  await expect(page.locator("#share")).toBeVisible({ timeout: 30_000 })
  const width = await page.locator("#bar").evaluate((el) => {
    return parseInt((el as HTMLElement).style.width || "0")
  })
  expect(width).toBe(100)
})

// ─── Recipes page ─────────────────────────────────────────────────────────────

test("recipes page has a back button", async ({ page }) => {
  await page.goto("/recipes")
  await expect(page.locator("a.link[href='/']")).toBeVisible()
})

test("recipes page without tokens shows placeholders", async ({ page }) => {
  await page.goto("/recipes")
  const code = await page.locator(".code").first().textContent()
  expect(code).toContain("downloadToken")
})

test("CLI recipes link from upload page passes real tokens", async ({ page }) => {
  await page.goto("/")
  const cfg = await getPageCfg(page)
  const href = await page.locator("#recipes-link").getAttribute("href")

  expect(href).toContain(`ut=${cfg.uploadToken}`)
  expect(href).toContain(`dt=${cfg.downloadToken}`)
})

test("recipes page with tokens shows actual token values and dynamic host", async ({ page }) => {
  await page.goto("/")
  const cfg = await getPageCfg(page)

  // Navigate directly to the recipes URL with actual tokens
  await page.goto(`/recipes?ut=${cfg.uploadToken}&dt=${cfg.downloadToken}`)

  // Should contain the actual token (not a placeholder)
  const allCode = await page.locator(".code").allTextContents()
  const combined = allCode.join("\n")
  expect(combined).toContain(cfg.downloadToken)
  expect(combined).toContain(cfg.uploadToken)

  // Host placeholders should be replaced with location.origin at runtime
  expect(combined).toContain("http://localhost:4000")
  expect(combined).not.toContain("host-ph")
})

test("clicking CLI recipes link from upload page shows real tokens", async ({ page }) => {
  await page.goto("/")
  const cfg = await getPageCfg(page)

  await page.locator("#recipes-link").click()
  await page.waitForLoadState()

  const allCode = await page.locator(".code").allTextContents()
  const combined = allCode.join("\n")
  expect(combined).toContain(cfg.downloadToken)
  expect(combined).toContain(cfg.uploadToken)
  expect(combined).toContain("http://localhost:4000")
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
    window.__firstFetch = fetch(`/upload/${token}`, {
      method: 'PUT',
      body: stream,
      duplex: 'half',
      signal: window.__abortController.signal
    }).catch(() => {})
  }, cfg.uploadToken)

  // Small delay then try a second sender
  await page.waitForTimeout(50)
  
  const retry = await page.evaluate(async (token) => {
    const res = await fetch(`/upload/${token}`, {
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
