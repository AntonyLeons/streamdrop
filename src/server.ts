import { createApp } from "./app"

const port = Number(Bun.env.PORT ?? "3000")
const app = createApp()

Bun.serve({ port, fetch: app.fetch })
