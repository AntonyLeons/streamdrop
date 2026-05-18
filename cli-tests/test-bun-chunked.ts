import { serve } from "bun";
const { readable, writable } = new TransformStream();

serve({
  port: 5008,
  async fetch(req) {
    if (req.method === "POST") {
      await req.body.pipeTo(writable);
      return new Response("ok");
    }
    return new Response(readable);
  }
});
