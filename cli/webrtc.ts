import { RTCPeerConnection, RTCIceCandidate } from "werift"
import type { RTCSessionDescriptionInit } from "werift"
import { Readable } from "node:stream"

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]

async function pollSignal(server: string, sessionId: string, role: string, signal?: AbortSignal): Promise<any[]> {
  while (true) {
    if (signal?.aborted) return []
    let res: Response
    try {
      res = await fetch(`${server}/signal/${sessionId}/${role}`, { signal })
    } catch {
      if (signal?.aborted) return []
      await sleep(400)
      continue
    }
    if (!res.ok) {
      await sleep(400)
      continue
    }
    try {
      const msgs = await res.json()
      if (msgs && msgs.length > 0) return msgs
    } catch {}
    await sleep(400)
  }
}

async function postSignal(server: string, sessionId: string, msg: any, signal?: AbortSignal) {
  try {
    await fetch(`${server}/signal/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
      signal,
    })
  } catch {}
}

async function establishP2P(server: string, sessionId: string, role: "sender" | "receiver", signal?: AbortSignal) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const dc = role === "sender" ? pc.createDataChannel("streamdrop", { ordered: true }) : null

  dc?.addEventListener("close", () => closeP2P(pc))
  dc?.addEventListener("error", () => closeP2P(pc))

  // Send local ICE candidates as they trickle in — must be before setLocalDescription
  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) {
      postSignal(server, sessionId, { from: role, type: "ice", data: { candidate } }, signal).catch(() => {})
    }
  })

  if (role === "sender") {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const sdp = pc.localDescription
    await postSignal(server, sessionId, { from: "sender", type: "offer", data: { sdp: { type: sdp?.type, sdp: sdp?.sdp } } }, signal)

    const answers = await pollSignal(server, sessionId, "sender", signal)
    for (const msg of answers) {
      if (msg.type === "answer") {
        await pc.setRemoteDescription(msg.data.sdp)
      } else if (msg.type === "ice" && msg.data?.candidate) {
        try { await pc.addIceCandidate(msg.data.candidate) } catch {}
      }
    }
  } else {
    const offers = await pollSignal(server, sessionId, "receiver", signal)
    const sdp = offers.find((m: any) => m.type === "offer")
    if (sdp) {
      await pc.setRemoteDescription(sdp.data.sdp)

      for (const msg of offers) {
        if (msg.type === "ice" && msg.data?.candidate) {
          try { await pc.addIceCandidate(msg.data.candidate) } catch {}
        }
      }

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      const localSdp = pc.localDescription
      await postSignal(server, sessionId, { from: "receiver", type: "answer", data: { sdp: { type: localSdp?.type, sdp: localSdp?.sdp } } }, signal)
    }
  }

  // Now that signaling is done, start ICE timeout and connection watchers
  let settled = false
  const settledP = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("p2p_timeout")) }
    }, 15_000)

    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      if (!settled) { settled = true; reject(new DOMException("Aborted", "AbortError")) }
    }, { once: true })

    const onDone = () => { if (!settled) { settled = true; clearTimeout(t); resolve() } }
    const onFail = (err: any) => { if (!settled) { settled = true; clearTimeout(t); reject(err) } }

    pc.onIceConnectionStateChange.subscribe((s) => {
      if (s === "connected" || s === "completed") onDone()
      else if (s === "failed") onFail(new Error("p2p_ice_failed"))
    })

    if (role === "receiver") {
      pc.onDataChannel.subscribe(() => onDone())
    }
  })

  let remoteDc: any
  const dcPromise = role === "receiver"
    ? new Promise<any>((r) => {
        pc.onDataChannel.subscribe((ch) => {
          remoteDc = ch
          ch.addEventListener("close", () => closeP2P(pc))
          ch.addEventListener("error", () => closeP2P(pc))
          r(ch)
        })
      })
    : Promise.resolve(dc)

  // Start background ICE polling AFTER offer/answer exchange
  let polling = true
  ;(async () => {
    while (polling && !signal?.aborted) {
      const msgs = await pollSignal(server, sessionId, role, signal)
      for (const msg of msgs) {
        if (msg.type === "ice" && msg.data?.candidate) {
          try { await pc.addIceCandidate(msg.data.candidate) } catch {}
        }
      }
    }
  })()

  pc.onConnectionStateChange.subscribe((state) => {
    if (state === "connected" || state === "failed" || state === "disconnected") {
      polling = false
    }
  })

  await settledP

  const dataChannel = role === "sender" ? dc : await dcPromise
  return { pc, dc: dataChannel, close: () => closeP2P(pc) }
}

function closeP2P(pc: RTCPeerConnection) {
  try { pc.close() } catch {}
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function sendViaP2P(server: string, stream: ReadableStream, sessionId: string, signal?: AbortSignal): Promise<boolean> {
  let p2p: any
  try {
    p2p = await establishP2P(server, sessionId, "sender", signal)
  } catch {
    return false
  }

  const { dc, close } = p2p
  dc.bufferedAmountLowThreshold = 524_288

  const reader = stream.getReader()
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
      const { value, done } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue

      if (dc.readyState !== "open") throw new Error("dc_closed")
      if (dc.bufferedAmount > 2_097_152) {
        await new Promise<void>((r) => {
          const handler = () => { dc.removeEventListener("bufferedamountlow", handler); r() }
          dc.addEventListener("bufferedamountlow", handler, { once: true })
        })
      }
      dc.send(Buffer.from(value))
    }
    while (dc.bufferedAmount > 0) {
      await new Promise<void>((r) => {
        const handler = () => { dc.removeEventListener("bufferedamountlow", handler); r() }
        dc.addEventListener("bufferedamountlow", handler, { once: true })
      })
    }
  } finally {
    reader.cancel().catch(() => {})
    close()
  }
  return true
}

export function receiveViaP2P(server: string, sessionId: string, signal?: AbortSignal): ReadableStream {
  let p2p: any
  return new ReadableStream({
    async start(controller) {
      try {
        p2p = await establishP2P(server, sessionId, "receiver", signal)
      } catch {
        controller.error(new Error("p2p_failed"))
        return
      }

      const { dc } = p2p

      dc.onMessage.subscribe((data: any) => {
        try {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
          controller.enqueue(new Uint8Array(buf))
        } catch {
          try { controller.error(new Error("decoder_failed")) } catch {}
        }
      })

      dc.addEventListener("close", () => {
        try { controller.close() } catch {}
      })

      dc.addEventListener("error", () => {
        try { controller.error(new Error("dc_error")) } catch {}
      })

      signal?.addEventListener("abort", () => {
        try { controller.error(new DOMException("Aborted", "AbortError")) } catch {}
      }, { once: true })
    },
    cancel() {
      if (p2p) p2p.close()
    },
  })
}
