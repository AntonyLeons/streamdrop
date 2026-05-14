const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]

async function pollSignal(sessionId, role, signal) {
  while (true) {
    if (signal?.aborted) return []
    let res
    try {
      res = await fetch(`/signal/${sessionId}/${role}`, { signal })
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

async function postSignal(sessionId, msg, signal) {
  try {
    await fetch(`/signal/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
      signal,
    })
  } catch {}
}

export async function establishP2P(sessionId, role, signal) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const dc = role === "sender" ? pc.createDataChannel("streamdrop", { ordered: true }) : null
  dc?.addEventListener("close", () => closeP2P(pc))
  dc?.addEventListener("error", () => closeP2P(pc))

  let settled = false
  const settledP = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("p2p_timeout")) }
    }, 15_000)

    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      if (!settled) { settled = true; reject(new DOMException("Aborted", "AbortError")) }
    }, { once: true })

    const onDone = () => {
      if (!settled) { settled = true; clearTimeout(t); resolve() }
    }
    const onFail = (err) => {
      if (!settled) { settled = true; clearTimeout(t); reject(err) }
    }

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      if (s === "connected" || s === "completed") onDone()
      else if (s === "failed") onFail(new Error("p2p_ice_failed"))
    }

    if (role === "receiver") {
      pc.ondatachannel = (e) => {
        onDone()
      }
    }
  })

  let remoteDc
  const dcPromise = role === "receiver"
    ? new Promise((r) => {
        const orig = pc.ondatachannel
        pc.ondatachannel = (e) => {
          remoteDc = e.channel
          remoteDc.addEventListener("close", () => closeP2P(pc))
          remoteDc.addEventListener("error", () => closeP2P(pc))
          r(e.channel)
        }
      })
    : Promise.resolve(dc)

  if (role === "sender") {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await postSignal(sessionId, { from: "sender", type: "offer", data: { sdp: pc.localDescription } }, signal)

    const answers = await pollSignal(sessionId, "sender", signal)
    const sdp = answers.find((m) => m.type === "answer")
    if (sdp) await pc.setRemoteDescription(new RTCSessionDescription(sdp.data.sdp))

    iceExchange(pc, sessionId, "sender", signal)
    await settledP
  } else {
    const offers = await pollSignal(sessionId, "receiver", signal)
    const sdp = offers.find((m) => m.type === "offer")
    if (sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp.data.sdp))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await postSignal(sessionId, { from: "receiver", type: "answer", data: { sdp: pc.localDescription } }, signal)
    }
    iceExchange(pc, sessionId, "receiver", signal)
    await settledP
  }

  const dataChannel = role === "sender" ? dc : await dcPromise
  return { pc, dc: dataChannel, close: () => closeP2P(pc) }
}

function iceExchange(pc, sessionId, role, signal) {
  const other = role === "sender" ? "receiver" : "sender"
  let polling = true

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      postSignal(sessionId, { from: role, type: "ice", data: { candidate: e.candidate.toJSON() } }, signal).catch(() => {})
    }
  }

  ;(async () => {
    while (polling && !signal?.aborted) {
      const msgs = await pollSignal(sessionId, role, signal)
      for (const msg of msgs) {
        if (msg.type === "ice" && msg.data.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate))
          } catch {}
        }
      }
    }
  })()

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected" || pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      polling = false
    }
  })
}

function closeP2P(pc) {
  try {
    pc.close()
  } catch {}
}

export async function sendViaP2P(stream, sessionId, signal) {
  let p2p
  try {
    p2p = await establishP2P(sessionId, "sender", signal)
  } catch {
    return false
  }

  const { dc, close } = p2p
  dc.binaryType = "arraybuffer"
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
        await new Promise((r) => dc.addEventListener("bufferedamountlow", r, { once: true }))
      }
      dc.send(value)
    }
  } finally {
    reader.cancel().catch(() => {})
    close()
  }
  return true
}

export function receiveViaP2P(sessionId, signal) {
  let p2p
  return new ReadableStream({
    async start(controller) {
      try {
        p2p = await establishP2P(sessionId, "receiver", signal)
      } catch {
        controller.error(new Error("p2p_failed"))
        return
      }

      const { dc } = p2p
      dc.binaryType = "arraybuffer"

      dc.onmessage = (e) => {
        try {
          const buf = e.data instanceof ArrayBuffer ? e.data : e.data.buffer
          controller.enqueue(new Uint8Array(buf))
        } catch {
          try { controller.error(new Error("decoder_failed")) } catch {}
        }
      }

      dc.onclose = () => {
        try { controller.close() } catch {}
      }

      dc.onerror = () => {
        try { controller.error(new Error("dc_error")) } catch {}
      }

      signal?.addEventListener("abort", () => {
        try { controller.error(new DOMException("Aborted", "AbortError")) } catch {}
      }, { once: true })
    },
    cancel() {
      if (p2p) p2p.close()
    },
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
