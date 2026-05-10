import { createApp } from "./app"
import { startSessionReaper } from "./sessions"

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err)
})

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason)
})

const port = Number(Bun.env.PORT ?? "3000")
const app = createApp()

startSessionReaper()

try {
  Bun.serve({ 
    port, 
    fetch: app.fetch, 
    idleTimeout: 0, 
    h3: true,
    error(err) {
      console.error("Server Error:", err)
      return new Response("Internal Server Error", { status: 500 })
    }
  })
  if (Bun.env.NODE_ENV !== "production") console.log(`streamdrop listening on http://localhost:${port}`)
} catch (e) {
  console.error("streamdrop failed to start", e)
  throw e
}
