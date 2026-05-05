import { test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createApp } from "../src/app"

let testServer: any
let serverUrl: string
let cliBinaryPath = join(process.cwd(), "dist", "streamdrop")

beforeAll(async () => {
  const app = createApp()
  // Start local server for tests
  testServer = Bun.serve({
    fetch: app.fetch,
    port: 0, // Random open port
  })
  serverUrl = `http://localhost:${testServer.port}`
})

afterAll(async () => {
  if (testServer) testServer.stop()
})

test("CLI sends and receives a file successfully", async () => {
  const testFileName = `cli-test-${Date.now()}.bin`
  const testFilePath = join(tmpdir(), testFileName)
  const receivedFilePath = join(process.cwd(), testFileName) // CLI downloads to CWD
  
  // Generate 2MB of random data
  const testData = randomBytes(2 * 1024 * 1024)
  await writeFile(testFilePath, testData)

  let shareUrl = ""
  
  // Start the sender
  const sender = spawn(cliBinaryPath, ["send", testFilePath, "--server", serverUrl])
  
  // Read sender output to get the share URL
  await new Promise<void>((resolve, reject) => {
    let output = ""
    sender.stdout.on("data", (data) => {
      output += data.toString()
      const match = output.match(/Share URL: (http[^\s]+)/)
      if (match) {
        shareUrl = match[1]
        resolve()
      }
    })
    sender.stderr.on("data", (data) => console.error("Sender stderr:", data.toString()))
    sender.on("error", reject)
  })

  expect(shareUrl).toBeTruthy()

  // Start the receiver
  const receiver = spawn(cliBinaryPath, ["receive", shareUrl, "--server", serverUrl])
  
  await new Promise<void>((resolve, reject) => {
    receiver.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Receiver exited with code ${code}`))
    })
    receiver.on("error", reject)
  })

  // Wait for sender to finish after receiver claims it
  await new Promise<void>((resolve) => {
    sender.on("close", () => resolve())
    // Or we can just kill it if it stays alive (though CLI doesn't exit automatically unless we add it, wait, does runSend exit? It has `while(true)`. Let's check.)
    // Actually, send loops forever waiting for MORE receivers. We need to kill it.
    sender.kill()
    resolve()
  })

  // Verify the received file matches original
  const receivedData = await readFile(receivedFilePath)
  expect(receivedData.length).toBe(testData.length)
  expect(receivedData.equals(testData)).toBe(true)

  // Cleanup
  await rm(testFilePath, { force: true })
  await rm(receivedFilePath, { force: true })
}, 15000)
