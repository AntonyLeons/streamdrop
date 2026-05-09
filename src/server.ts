import { createApp } from "./app"
import { startSessionReaper } from "./sessions"

const port = Number(Bun.env.PORT ?? "3000")
const app = createApp()

startSessionReaper()

try {
  Bun.serve({ port, fetch: app.fetch, idleTimeout: 0, h3: true })
  if (Bun.env.NODE_ENV !== "production") console.log(`streamdrop listening on http://localhost:${port}`)
} catch (e) {
  console.error("streamdrop failed to start", e)
  throw e
}
