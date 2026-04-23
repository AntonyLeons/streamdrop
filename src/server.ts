import { createApp } from "./app"
import { startSessionReaper } from "./sessions"
import { tryUpgradeSignal, websocket } from "./signal"

const port = Number(Bun.env.PORT ?? "3000")
const app = createApp()

startSessionReaper()

try {
  Bun.serve({
    port,
    idleTimeout: 0,
    fetch(req, server) {
      const res = tryUpgradeSignal(req, server)
      if (res) return res
      return app.fetch(req)
    },
    websocket,
  })
  if (Bun.env.NODE_ENV !== "production") console.log(`streamdrop listening on http://localhost:${port}`)
} catch (e) {
  console.error("streamdrop failed to start", e)
  throw e
}
