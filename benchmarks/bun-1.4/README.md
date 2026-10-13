# Bun 1.4 benchmark

This compares Bun 1.3.14 (the final Zig release) with Bun 1.4.2 (Rust) in
official Linux ARM64 Docker images. Both server containers should receive the
same CPU and memory limits. Report medians, not the single fastest run.

Workloads:

- process startup (`bun empty.ts`)
- idle server memory (`docker stats`)
- HTTP `/health` and `/json` throughput/latency
- repeated JSON parsing/stringifying (`cpu.ts`)

The JavaScript engine remains JavaScriptCore, so `cpu.ts` is a control as much
as a benchmark: a Rust rewrite should not automatically make ordinary
JavaScript execution faster.

## Results (2026-09-09)

Apple M1 Max host, Docker Engine 29.4.0, Linux ARM64 containers, one CPU and
512 MiB per server. Values are medians of five runs except the JSON control
(seven runs). HTTP runs used `wrk`, 2 threads, 64 connections, and 5 seconds.

| Workload | Bun 1.3.14 (Zig) | Bun 1.4.2 (Rust) | Change |
| --- | ---: | ---: | ---: |
| Empty script startup | 9.264 ms | 2.326 ms | 74.9% less time (3.98x) |
| JSON parse/stringify control | 309.50 ms | 249.19 ms | 19.5% less time (1.24x) |
| `GET /health` | 143,869 req/s | 155,497 req/s | 8.1% more throughput |
| `GET /json` | 121,292 req/s | 142,272 req/s | 17.3% more throughput |
| Idle server memory | 90.8 MiB | 51.5 MiB | 43.3% less memory |
| Idle CPU (short sample) | 0.16% | 0.04% | 75% less (4x) |
| 128 MiB StreamDrop relay | 621 MiB/s | 943 MiB/s | 51.9% more throughput |
| Relay elapsed time | 206.1 ms | 135.7 ms | 34.2% less time |
| Relay peak RSS | 117.8 MiB | 68.2 MiB | 42.1% less memory |
| Relay CPU time | 227.7 ms | 142.8 ms | 37.3% less CPU time |

Treat the idle CPU number as directional: percentages this close to zero are
noisy. These results compare complete releases, so gains can come from the Rust
port, the newer JavaScriptCore, allocator work, and other changes shipped in
1.4; they do not isolate the implementation language by itself.

### Transfer compatibility finding

The relay benchmark uses StreamDrop's real session, claim, raw upload, and raw
download routes and verifies the received byte count. Seven 128 MiB transfers
completed on each release.

At 256 MiB, all five Bun 1.3.14 transfers completed, while all five Bun 1.4.2
transfers failed with `Request body exceeded maxRequestBodySize` and StreamDrop
returned `409 receivers_lost`. The failure begins above Bun 1.4's current
128 MiB default request-body limit. StreamDrop must explicitly configure
`maxRequestBodySize` before upgrading if it intends to preserve unlimited
streaming transfers.
