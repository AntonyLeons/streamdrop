import { serve } from "bun";
import { TransformStream } from "node:stream/web";

const channels = new Map();

serve({
  port: 5009,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/upload") {
      const { readable, writable } = new TransformStream();
      channels.set("test", { writable, readable });
      await req.body.pipeTo(writable, { signal: req.signal });
      return new Response("ok");
    }
    if (url.pathname === "/download") {
      const ch = channels.get("test");
      if (!ch) return new Response("not found", { status: 404 });
      return new Response(ch.readable);
    }
    return new Response("not found");
  }
});
