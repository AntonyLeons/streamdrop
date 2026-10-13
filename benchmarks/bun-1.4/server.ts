const payload = JSON.stringify({
  service: "streamdrop",
  ok: true,
  values: Array.from({ length: 32 }, (_, index) => index),
})

Bun.serve({
  port: 3000,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/health") return new Response("ok")
    if (path === "/json") {
      return new Response(payload, {
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  },
})

