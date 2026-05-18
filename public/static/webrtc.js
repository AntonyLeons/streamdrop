let ICE_SERVERS = null

async function loadIceServers(sessionId) {
  if (ICE_SERVERS) return ICE_SERVERS
  try {
    const res = await fetch(`/config?session=${encodeURIComponent(sessionId)}`)
    if (res.ok) {
      const data = await res.json()
      ICE_SERVERS = data.iceServers
    }
  } catch (e) {
    console.warn("[WebRTC] Failed to load ICE config, using defaults")
  }
  if (!ICE_SERVERS) {
    ICE_SERVERS = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ]
  }
  return ICE_SERVERS
}

async function postSignal(sessionId, msg) {
  console.log("[WebRTC] Sending signal:", msg.type)
  try {
    await fetch(`/signal/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg)
    })
  } catch (e) {
    console.error("[WebRTC] Failed to post signal", e)
  }
}

export async function establishP2P(sessionId, role, signal) {
  const iceServers = await loadIceServers(sessionId)
  console.log("[WebRTC] Starting as", role, "session:", sessionId, "ICE servers:", iceServers.length)
  
  return new Promise((resolve, reject) => {
    let cleanup = null
    const pc = new RTCPeerConnection({ iceServers })
    let dc = null
    let cursor = 0
    let isPolling = true
    const bufferedIceCandidates = []
    let resolved = false

    const doCleanup = () => {
      console.log("[WebRTC] doCleanup called, resolved:", resolved)
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
        pc.oniceconnectionstatechange = null
        pc.onicegatheringstatechange = null
        pc.close()
      }
      if (signal) signal.removeEventListener("abort", onAbort)
    }

    const doResolve = (result) => {
      if (resolved) {
        console.log("[WebRTC] Already resolved, ignoring")
        return
      }
      console.log("[WebRTC] *** RESOLVING P2P SUCCESS ***")
      resolved = true
      isPolling = false
      resolve(result)
    }

    const onAbort = () => {
      console.log("[WebRTC] Abort signaled")
      doCleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }

    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
    }

    cleanup = () => doCleanup()

    const checkAndResolve = () => {
      if (resolved) return
      console.log("[WebRTC] checkAndResolve - dc:", dc?.readyState, "pc state:", pc.connectionState)
      if (dc && dc.readyState === "open") {
        doResolve({ dc, pc, cleanup })
      }
    }

    pc.onconnectionstatechange = () => {
      console.log("[WebRTC] connectionState:", pc.connectionState, "dc:", dc?.readyState)
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        if (!resolved) {
          doCleanup()
          reject(new Error(`WebRTC connection ${pc.connectionState}`))
        }
      }
      checkAndResolve()
    }

    pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] iceConnectionState:", pc.iceConnectionState)
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        if (!resolved) {
          doCleanup()
          reject(new Error(`WebRTC ICE connection ${pc.iceConnectionState}`))
        }
      }
      checkAndResolve()
    }

    pc.onsignalingstatechange = () => {
      console.log("[WebRTC] signalingState:", pc.signalingState)
    }

    pc.onicegatheringstatechange = () => {
      console.log("[WebRTC] iceGatheringState:", pc.iceGatheringState)
      if (pc.iceGatheringState === "complete" && pc.localDescription) {
        postSignal(sessionId, { from: role, type: pc.localDescription.type, data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log("[WebRTC] Local ICE candidate:", e.candidate.candidate)
        postSignal(sessionId, { from: role, type: "ice", data: e.candidate.toJSON() })
      } else {
        console.log("[WebRTC] ICE gathering complete (null candidate)")
      }
    }

    const handleSignal = async (msg) => {
      if (msg.from === role || !isPolling) return

      console.log("[WebRTC] Received signal:", msg.type, "from:", msg.from)
      try {
        if (msg.type === "offer" && role === "receiver") {
          console.log("[WebRTC] Setting remote offer")
          await pc.setRemoteDescription(new RTCSessionDescription(msg.data))
          console.log("[WebRTC] Creating answer")
          const answer = await pc.createAnswer()
          console.log("[WebRTC] Setting local description")
          await pc.setLocalDescription(answer)
          console.log("[WebRTC] Sending answer back")
          postSignal(sessionId, { from: role, type: "answer", data: { type: answer.type, sdp: answer.sdp } })

          console.log("[WebRTC] Processing buffered ICE candidates:", bufferedIceCandidates.length)
          for (const cand of bufferedIceCandidates) {
            console.log("[WebRTC] Adding buffered candidate")
            await pc.addIceCandidate(cand).catch(e => console.log("[WebRTC] Add buffered candidate failed:", e))
          }
          bufferedIceCandidates.length = 0
        } else if (msg.type === "answer" && role === "sender") {
          console.log("[WebRTC] Setting remote answer")
          await pc.setRemoteDescription(new RTCSessionDescription(msg.data))
        } else if (msg.type === "ice") {
          console.log("[WebRTC] Processing ICE candidate from peer")
          const cand = new RTCIceCandidate(msg.data)
          if (pc.remoteDescription) {
            await pc.addIceCandidate(cand).catch(e => console.log("[WebRTC] Add ICE candidate failed:", e))
          } else {
            console.log("[WebRTC] Buffering ICE candidate (no remote description yet)")
            bufferedIceCandidates.push(cand)
          }
        }
      } catch (err) {
        console.log("[WebRTC] handleSignal error:", err)
      }
    }

    const pollSignals = async () => {
      console.log("[WebRTC] Starting signal polling")
      while (isPolling) {
        try {
          const res = await fetch(`/signal/${sessionId}?cursor=${cursor}`)
          if (!res.ok) {
            await new Promise(r => setTimeout(r, 1000))
            continue
          }
          const data = await res.json()
          if (data && data.signals && data.signals.length > 0) {
            console.log("[WebRTC] Got", data.signals.length, "signals from cursor", cursor)
            for (const msg of data.signals) {
              await handleSignal(msg)
            }
            cursor = data.nextCursor
          }
        } catch (err) {
          console.log("[WebRTC] pollSignals fetch error:", err)
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      console.log("[WebRTC] Stopping signal polling")
    }

    // Continuous checking
    console.log("[WebRTC] Starting openCheckInterval")
    const openCheckInterval = setInterval(() => {
      if (resolved) {
        clearInterval(openCheckInterval)
        return
      }
      if (dc) {
        console.log("[WebRTC] openCheck - dc.readyState:", dc.readyState)
      }
      checkAndResolve()
    }, 100)

    if (role === "sender") {
      console.log("[WebRTC] Creating data channel as sender")
      dc = pc.createDataChannel("streamdrop-transfer", {
        ordered: true,
        bufferedAmountLowThreshold: 1024 * 1024
      })

      console.log("[WebRTC] Data channel created, initial state:", dc.readyState)
      
      dc.onopen = () => {
        console.log("[WebRTC] dc.onopen fired")
        checkAndResolve()
      }
      
      dc.onerror = (e) => {
        console.log("[WebRTC] dc.onerror:", e)
        if (!resolved) {
          doCleanup()
          reject(e instanceof Error ? e : new Error(e?.message || "Data channel error"))
        }
      }

      console.log("[WebRTC] Creating offer...")
      pc.createOffer()
        .then(offer => {
          console.log("[WebRTC] Offer created, setting local description")
          return pc.setLocalDescription(offer)
        })
        .then(() => {
          console.log("[WebRTC] Local description set, sending offer")
          // Send initial offer immediately (trickle ICE)
          postSignal(sessionId, { from: role, type: "offer", data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })
        })
        .catch(err => {
          console.log("[WebRTC] Offer creation/setting failed:", err)
          if (!resolved) {
            doCleanup()
            reject(err)
          }
        })
    } else {
      console.log("[WebRTC] Waiting for incoming data channel (receiver role)")
      pc.ondatachannel = (event) => {
        console.log("[WebRTC] *** ondatachannel RECEIVED from sender ***")
        dc = event.channel
        console.log("[WebRTC] Incoming dc initial state:", dc.readyState)
        
        dc.onopen = () => {
          console.log("[WebRTC] *** dc.onopen FIRED on receiver ***")
          checkAndResolve()
        }
        
        dc.onerror = (e) => {
          console.log("[WebRTC] Receiver dc.onerror:", e)
          if (!resolved) {
            doCleanup()
            reject(e instanceof Error ? e : new Error(e?.message || "Data channel error"))
          }
        }
        
        // Check immediately in case already open
        checkAndResolve()
      }
    }

    pollSignals()
  })
}

export function sendViaP2P(dc, stream, signal) {
  console.log("[WebRTC] sendViaP2P starting, dc.readyState:", dc.readyState)
  return new Promise(async (resolve, reject) => {
    let isDone = false
    let chunksSent = 0
    let bytesSent = 0
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
            console.log("[WebRTC] sendViaP2P waiting for buffer drain:", dc.bufferedAmount)
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
            console.log("[WebRTC] sendViaP2P stream complete, chunks:", chunksSent, "bytes:", bytesSent)
            isDone = true
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
            console.log("[WebRTC] sendViaP2P resolve")
            resolve()
            break
          }
          
          if (dc.readyState !== "open") {
            console.log("[WebRTC] sendViaP2P error: dc not open, state:", dc.readyState)
            throw new Error("Data channel is not open")
          }
          
          dc.send(value)
          chunksSent++
          bytesSent += value.byteLength
          if (chunksSent % 100 === 0) {
            console.log("[WebRTC] sendViaP2P progress: chunks:", chunksSent, "bytes:", bytesSent)
          }
        }
      } catch (err) {
        console.log("[WebRTC] sendViaP2P error:", err, "chunks:", chunksSent, "bytes:", bytesSent)
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
  console.log("[WebRTC] receiveViaP2P created, dc.readyState:", dc.readyState)
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
        console.log("[WebRTC] receiveViaP2P got", data.length, "bytes")
        controller.enqueue(data)
      }

      dc.onclose = () => {
        console.log("[WebRTC] receiveViaP2P dc.onclose")
        if (signal) signal.removeEventListener("abort", onAbort)
        try { controller.close() } catch (e) {}
      }

      dc.onerror = (e) => {
        console.log("[WebRTC] receiveViaP2P dc.onerror:", e)
        if (signal) signal.removeEventListener("abort", onAbort)
        controller.error(e)
      }
    },
    cancel() {
      console.log("[WebRTC] receiveViaP2P cancel")
      try { dc.close() } catch (e) {}
    }
  })
}
