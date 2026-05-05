const tar = Bun.spawn(["tar", "-cf", "-", "README.md"], { stdout: "pipe" });
const extract = Bun.spawn(["tar", "-xf", "-", "-C", "/tmp"], { stdin: "pipe" });

const writer = new WritableStream({
  write(chunk) {
    extract.stdin.write(chunk);
  },
  close() {
    extract.stdin.end();
  }
});

await tar.stdout.pipeTo(writer);
await extract.exited;
console.log("Done");
