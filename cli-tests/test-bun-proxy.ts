import { serve } from "bun";
const { readable, writable } = new TransformStream();

const writer = writable.getWriter();
setInterval(() => {
  writer.write(new Uint8Array(1024 * 1024)); // 1MB chunk
}, 10); // 100 MB/s

serve({
  port: 5005,
  fetch(req) {
    return new Response(readable);
  }
});
