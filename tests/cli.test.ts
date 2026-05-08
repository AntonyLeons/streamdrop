import { test, expect, beforeAll, afterAll } from "bun:test"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rm, writeFile, readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { createApp } from "../src/app"

let testServer: any
let serverUrl: string
const bunPath = process.execPath
const cliScriptPath = join(process.cwd(), "cli", "index.ts")

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

test("CLI receives using the new quote-free receive code format", async () => {
  const testFileName = `cli-test-quotefree-${Date.now()}.bin`
  const testFilePath = join(tmpdir(), testFileName)
  const receivedFilePath = join(process.cwd(), testFileName)

  const testData = randomBytes(1024)
  await writeFile(testFilePath, testData)

  let receiveCode = ""
  
  const sender = spawn(bunPath, [cliScriptPath, "send", testFilePath, "--server", serverUrl])
  
  await new Promise<void>((resolve, reject) => {
    let output = ""
    sender.stdout.on("data", (data) => {
      output += data.toString()
      const match = output.match(/Receive: streamdrop receive ([^\s]+)/)
      if (match) {
        receiveCode = match[1]
        resolve()
      }
    })
    sender.on("error", reject)
  })

  expect(receiveCode).toBeTruthy()
  expect(receiveCode).toContain(":")

  const receiver = spawn(bunPath, [cliScriptPath, "receive", receiveCode, "--server", serverUrl])
  
  await new Promise<void>((resolve, reject) => {
    receiver.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Receiver exited with code ${code}`))
    })
    receiver.on("error", reject)
  })

  sender.kill()

  const receivedData = await readFile(receivedFilePath)
  expect(receivedData.length).toBe(testData.length)

  await rm(testFilePath, { force: true })
  await rm(receivedFilePath, { force: true })
}, 15000)

test("CLI fails gracefully with a human-readable error for 404", async () => {
  const fakeCode = "fakeId:fakeKey:fake.txt"
  
  const receiver = spawn(bunPath, [cliScriptPath, "receive", fakeCode, "--server", serverUrl])
  
  let errOutput = ""
  await new Promise<void>((resolve) => {
    receiver.stderr.on("data", (data) => errOutput += data.toString())
    receiver.on("close", resolve)
  })

  expect(errOutput).toContain("Error: File session not found or has expired.")
  expect(errOutput).not.toContain("session_page_failed_404")
  expect(errOutput).not.toContain("at fetchSessionCfg")
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
  const sender = spawn(bunPath, [cliScriptPath, "send", testFilePath, "--server", serverUrl])
  
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
  const receiver = spawn(bunPath, [cliScriptPath, "receive", shareUrl, "--server", serverUrl])
  
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

test("CLI handles file overwrite protection correctly", async () => {
  const testFileName = `cli-test-overwrite-${Date.now()}.bin`
  const testFilePath = join(tmpdir(), testFileName)
  const receivedFilePath1 = join(process.cwd(), testFileName)
  const receivedFilePath2 = join(process.cwd(), `cli-test-overwrite-${Date.now()} (1).bin`) // We expect this, but the naming logic handles the base name

  const testData = randomBytes(1024)
  await writeFile(testFilePath, testData)

  let shareUrl = ""
  const sender = spawn(bunPath, [cliScriptPath, "send", testFilePath, "--server", serverUrl])
  
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
    sender.on("error", reject)
  })

  // Receiver 1
  const receiver1 = spawn(bunPath, [cliScriptPath, "receive", shareUrl, "--server", serverUrl])
  await new Promise<void>((resolve) => receiver1.on("close", resolve))
  expect(existsSync(receivedFilePath1)).toBe(true)

  // Receiver 2 (should create 'filename (1).bin')
  const receiver2 = spawn(bunPath, [cliScriptPath, "receive", shareUrl, "--server", serverUrl])
  await new Promise<void>((resolve) => receiver2.on("close", resolve))

  const expectedOverwrittenFile = receivedFilePath1.replace(".bin", " (1).bin")
  expect(existsSync(expectedOverwrittenFile)).toBe(true)

  sender.kill()
  
  await rm(testFilePath, { force: true })
  await rm(receivedFilePath1, { force: true })
  await rm(expectedOverwrittenFile, { force: true })
}, 15000)

test("CLI sends and extracts a folder automatically", async () => {
  const dirName = `cli-test-dir-${Date.now()}`
  const dirPath = join(tmpdir(), dirName)
  const receivedDirPath = join(process.cwd(), dirName)

  await mkdir(dirPath, { recursive: true })
  await writeFile(join(dirPath, "hello.txt"), "hello world")
  await writeFile(join(dirPath, "nested.bin"), randomBytes(1024))

  let shareUrl = ""
  const sender = spawn(bunPath, [cliScriptPath, "send", dirPath, "--server", serverUrl])
  
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
    sender.on("error", reject)
  })

  const receiver = spawn(bunPath, [cliScriptPath, "receive", shareUrl, "--server", serverUrl])
  await new Promise<void>((resolve) => receiver.on("close", resolve))
  sender.kill()

  // Verify extraction
  expect(existsSync(receivedDirPath)).toBe(true)
  expect(existsSync(join(receivedDirPath, "hello.txt"))).toBe(true)
  const helloContent = await readFile(join(receivedDirPath, "hello.txt"), "utf8")
  expect(helloContent).toBe("hello world")

  // Cleanup
  await rm(dirPath, { recursive: true, force: true })
  await rm(receivedDirPath, { recursive: true, force: true })
}, 15000)
