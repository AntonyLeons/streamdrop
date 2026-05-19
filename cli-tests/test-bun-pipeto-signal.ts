import { serve } from "bun";

const { readable, writable } = new TransformStream();

serve({
  port: 5007,
  async fetch(req) {
    if (req.method === "POST") {
      await req.body!.pipeTo(writable, { signal: req.signal });
      return new Response("ok");
    }
    return new Response(readable);
  }
});
