const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
]

async function postSignal(sessionId, msg) {
  try {
    await fetch(`/signal/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg)
    })
  } catch (e) {
    console.error("Failed to post signal", e)
  }
}

export async function establishP2P(sessionId, role, signal) {
  return new Promise((resolve, reject) => {
    let cleanup = null
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    let dc = null
    let cursor = 0
    let isPolling = true
    const bufferedIceCandidates = []

    const doCleanup = () => {
      isPolling = false
      if (dc) {
        dc.onopen = null
        dc.onclose = null
        dc.onerror = null
        dc.onmessage = null
      }
      if (pc) {
        pc.onicecandidate = null
        pc.ondatachannel = null
        pc.onconnectionstatechange = null
        pc.close()
      }
      if (signal) signal.removeEventListener("abort", onAbort)
    }

    const onAbort = () => {
      doCleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }

    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
    }

    cleanup = () => doCleanup()

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        doCleanup()
        reject(new Error(`WebRTC connection ${pc.connectionState}`))
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        postSignal(sessionId, { from: role, type: "ice", data: e.candidate.toJSON() })
      }
    }

    const handleSignal = async (msg) => {
      if (msg.from === role) return // Ignore own signals

      try {
        if (msg.type === "offer" && role === "receiver") {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.data))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          postSignal(sessionId, { from: role, type: "answer", data: { type: answer.type, sdp: answer.sdp } })

          // Add any buffered ICE candidates now that remote description is set
          for (const cand of bufferedIceCandidates) {
            await pc.addIceCandidate(cand).catch(console.error)
          }
          bufferedIceCandidates.length = 0
        } else if (msg.type === "answer" && role === "sender") {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.data))
        } else if (msg.type === "ice") {
          const cand = new RTCIceCandidate(msg.data)
          if (pc.remoteDescription) {
            await pc.addIceCandidate(cand).catch(console.error)
          } else {
            bufferedIceCandidates.push(cand)
          }
        }
      } catch (err) {
        console.error("Error handling signal:", err)
      }
    }

    const pollSignals = async () => {
      while (isPolling) {
        try {
          const res = await fetch(`/signal/${sessionId}?cursor=${cursor}`)
          if (!res.ok) {
            await new Promise(r => setTimeout(r, 1000))
            continue
          }
          const data = await res.json()
          if (data && data.signals && data.signals.length > 0) {
            for (const msg of data.signals) {
              await handleSignal(msg)
            }
            cursor = data.nextCursor
          }
        } catch (err) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }

    if (role === "sender") {
      dc = pc.createDataChannel("streamdrop-transfer", {
        ordered: true,
        // Using high bufferedAmountLowThreshold to allow efficient queueing
        bufferedAmountLowThreshold: 1024 * 1024
      })

      dc.onopen = () => {
        isPolling = false // Stop polling once connected
        resolve({ dc, pc, cleanup })
      }
      
      dc.onerror = (e) => {
        doCleanup()
        reject(e)
      }

      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => postSignal(sessionId, { from: role, type: "offer", data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }))
        .catch(err => {
          doCleanup()
          reject(err)
        })
    } else {
      pc.ondatachannel = (event) => {
        dc = event.channel
        dc.onopen = () => {
          isPolling = false
          resolve({ dc, pc, cleanup })
        }
        dc.onerror = (e) => {
          doCleanup()
          reject(e)
        }
      }
    }

    pollSignals()
  })
}

export function sendViaP2P(dc, stream, signal) {
  return new Promise(async (resolve, reject) => {
    let isDone = false
    const reader = stream.getReader()
    
    const onAbort = () => {
      isDone = true
      reader.cancel().catch(() => {})
      reject(new DOMException("Aborted", "AbortError"))
    }
    
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
    }

    const doSend = async () => {
      try {
        while (!isDone) {
          if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
            await new Promise(r => {
              const handler = () => {
                dc.removeEventListener("bufferedamountlow", handler)
                r()
              }
              dc.addEventListener("bufferedamountlow", handler)
            })
          }
          
          if (isDone) break

          const { done, value } = await reader.read()
          if (done) {
            isDone = true
            // Wait for all buffered data to be sent before resolving
            if (dc.bufferedAmount > 0) {
              await new Promise(r => {
                const check = setInterval(() => {
                  if (dc.bufferedAmount === 0 || dc.readyState !== "open") {
                    clearInterval(check)
                    r()
                  }
                }, 50)
              })
            }
            resolve()
            break
          }
          
          if (dc.readyState !== "open") {
            throw new Error("Data channel is not open")
          }
          
          dc.send(value)
        }
      } catch (err) {
        if (!isDone) {
          isDone = true
          reader.cancel().catch(() => {})
          reject(err)
        }
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort)
      }
    }
    
    doSend()
  })
}

export function receiveViaP2P(dc, signal) {
  return new ReadableStream({
    start(controller) {
      const onAbort = () => {
        controller.error(new DOMException("Aborted", "AbortError"))
      }
      
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener("abort", onAbort, { once: true })
      }

      dc.onmessage = (event) => {
        const data = new Uint8Array(event.data)
        controller.enqueue(data)
      }

      dc.onclose = () => {
        if (signal) signal.removeEventListener("abort", onAbort)
        try { controller.close() } catch (e) {}
      }

      dc.onerror = (e) => {
        if (signal) signal.removeEventListener("abort", onAbort)
        controller.error(e)
      }
    },
    cancel() {
      try { dc.close() } catch (e) {}
    }
  })
}
