import { getSessionByDownloadToken, getSessionByUploadToken } from "./sessions"
import type { Server, ServerWebSocket, WebSocketHandler } from "bun"

type Role = "send" | "recv"

type WSData = {
  id: string
  role: Role
  peerId: string
}

type Room = {
  sender: ServerWebSocket<WSData> | null
  receivers: Map<string, ServerWebSocket<WSData>>
  pending: Array<{ from: string; to: string | null; payload: string }>
}

const rooms = new Map<string, Room>()

export function tryUpgradeSignal(req: Request, server: Server<WSData>) {
  const url = new URL(req.url)
  if (!url.pathname.startsWith("/signal/")) return null

  const id = url.pathname.split("/")[2] || ""
  if (!id) return new Response("bad_request", { status: 400 })

  const ut = url.searchParams.get("ut") || ""
  const dt = url.searchParams.get("dt") || ""

  let role: Role | null = null
  if (ut) {
    const s = getSessionByUploadToken(ut)
    if (!s || s.id !== id) return new Response("unauthorized", { status: 401 })
    role = "send"
  } else if (dt) {
    const s = getSessionByDownloadToken(dt)
    if (!s || s.id !== id) return new Response("unauthorized", { status: 401 })
    role = "recv"
  } else {
    return new Response("unauthorized", { status: 401 })
  }

  const peerId = randomPeerId()
  const ok = server.upgrade(req, { data: { id, role, peerId } satisfies WSData })
  return ok ? new Response(null) : new Response("upgrade_failed", { status: 500 })
}

export const websocket: WebSocketHandler<WSData> = {
  open(ws: ServerWebSocket<WSData>) {
    const { id, role, peerId } = ws.data
    const room = getOrCreateRoom(id)
    if (role === "send") {
      if (room.sender && room.sender.readyState === WebSocket.OPEN) {
        try {
          room.sender.close(1013, "sender_exists")
        } catch {}
      }
      room.sender = ws
    } else {
      room.receivers.set(peerId, ws)
    }

    ws.send(JSON.stringify({ type: "hello", peerId, role }))

    flushPending(room)
  },

  message(ws: ServerWebSocket<WSData>, message: string | Uint8Array) {
    if (typeof message !== "string") return
    let obj: any = null
    try {
      obj = JSON.parse(message)
    } catch {
      return
    }

    const room = rooms.get(ws.data.id)
    if (!room) return

    const from = ws.data.peerId
    const to = typeof obj?.to === "string" ? obj.to : null
    const type = typeof obj?.type === "string" ? obj.type : ""
    const payload = typeof obj?.payload === "object" && obj.payload ? obj.payload : null
    if (!type) return

    const out = JSON.stringify({ type, from, to, payload })

    if (ws.data.role === "recv") {
      if (room.sender && room.sender.readyState === WebSocket.OPEN) {
        room.sender.send(out)
      } else {
        room.pending.push({ from, to: null, payload: out })
      }
      return
    }

    if (!to) return
    const rx = room.receivers.get(to)
    if (rx && rx.readyState === WebSocket.OPEN) {
      rx.send(out)
    } else {
      room.pending.push({ from, to, payload: out })
    }
  },

  close(ws: ServerWebSocket<WSData>) {
    const room = rooms.get(ws.data.id)
    if (!room) return
    if (ws.data.role === "send") {
      if (room.sender === ws) room.sender = null
    } else {
      room.receivers.delete(ws.data.peerId)
    }

    if (!room.sender && room.receivers.size === 0) rooms.delete(ws.data.id)
  },
}

function getOrCreateRoom(id: string): Room {
  let room = rooms.get(id)
  if (room) return room
  room = { sender: null, receivers: new Map(), pending: [] }
  rooms.set(id, room)
  return room
}

function flushPending(room: Room) {
  if (!room.pending.length) return
  const remaining: Room["pending"] = []
  for (const msg of room.pending) {
    if (msg.to === null) {
      if (room.sender && room.sender.readyState === WebSocket.OPEN) {
        room.sender.send(msg.payload)
      } else {
        remaining.push(msg)
      }
      continue
    }

    const rx = room.receivers.get(msg.to)
    if (rx && rx.readyState === WebSocket.OPEN) {
      rx.send(msg.payload)
    } else {
      remaining.push(msg)
    }
  }
  room.pending = remaining
}

function randomPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "").slice(0, 16)
}
