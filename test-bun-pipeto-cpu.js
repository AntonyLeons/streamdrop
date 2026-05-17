import { ReadableStream, WritableStream, TransformStream } from "node:stream/web";

const r = new ReadableStream({
  start(controller) {
    let i = 0;
    setInterval(() => {
      controller.enqueue(new Uint8Array(1024 * 1024)); // 1MB every 100ms = 10 MB/s
      i++;
      if (i > 100) controller.close();
    }, 100);
  }
});

const t = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk);
  }
});

const w = new WritableStream({
  write(chunk) {
    // fast writer
  }
});

r.pipeTo(t.writable);
t.readable.pipeTo(w);
