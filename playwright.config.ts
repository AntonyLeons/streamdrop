import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4000",
    // Chromium's headless shell doesn't support File System Access API,
    // so downloads fall back to blob URL → anchor click → browser download event.
    headless: true,
  },
  webServer: {
    command: "PORT=4000 ~/.bun/bin/bun src/server.ts",
    port: 4000,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
})
