import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4000",
    headless: true,
  },
  webServer: {
    command: "PORT=4000 go run ./cmd/streamdrop/",
    port: 4000,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
})
