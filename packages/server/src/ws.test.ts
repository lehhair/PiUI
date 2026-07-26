import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { createAppServer } from "./http.ts"
import { attachEventWebSocket, closeEventWebSocket } from "./ws.ts"
import { WebSocket } from "ws"
import { EventHub } from "./event-hub.ts"
import { EVENT_WS_SUBPROTOCOL_V2, eventStreamKeyV2 } from "@piui/protocol"

async function listen(server: ReturnType<typeof createAppServer>) {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(e => (e ? reject(e) : resolve()))
      }),
  }
}

describe("event websocket", () => {
  it("receives snapshot events during streamed prompt", async () => {
    const server = createAppServer({ authToken: null })
    attachEventWebSocket(server, { authToken: null })
    const { port, close } = await listen(server)
    const events: string[] = []
    let ws: WebSocket | undefined
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
      await new Promise<void>((resolve, reject) => {
        ws!.on("open", () => resolve())
        ws!.on("error", reject)
      })
      ws.on("message", data => {
        try {
          const msg = JSON.parse(String(data)) as { channel?: string; event?: { type: string } }
          if (msg.channel === "event" && msg.event?.type) events.push(msg.event.type)
        } catch {
          /* ignore */
        }
      })

      const seed = await fetch(`http://127.0.0.1:${port}/api/v1/dev/mock-chat`, { method: "POST" })
      assert.equal(seed.status, 201)
      const seeded = await seed.json()
      const sessionId = seeded.snapshot.session.id as string

      const prompt = await fetch(
        `http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/commands/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "stream me", stream: true }),
        },
      )
      assert.equal(prompt.status, 202)

      // allow last events to flush
      await new Promise(r => setTimeout(r, 50))
      assert.ok(events.includes("session.snapshot"), `got events: ${events.join(",")}`)
      assert.ok(events.includes("session.updated"))
    } finally {
      ws?.close()
      await close()
    }
  })

  it("replays events after a retained cursor", async () => {
    const eventHub = new EventHub(10)
    eventHub.publish({ type: "before-cursor", payload: 1 })
    const cursor = eventHub.getCursor()
    eventHub.publish({ type: "replay-two", payload: 2 })
    eventHub.publish({ type: "replay-three", payload: 3 })
    const server = createAppServer({ authToken: null, eventHub })
    attachEventWebSocket(server, { authToken: null })
    const { port, close } = await listen(server)
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/events?cursorEpoch=${encodeURIComponent(cursor.epoch)}&cursorSequence=${cursor.sequence}`,
    )
    try {
      const replayed = await new Promise<string[]>((resolve, reject) => {
        const types: string[] = []
        const timer = setTimeout(() => reject(new Error(`replay timeout: ${types.join(",")}`)), 2000)
        ws.on("message", data => {
          const msg = JSON.parse(String(data)) as { channel?: string; event?: { type: string } }
          if (msg.channel !== "event" || !msg.event) return
          types.push(msg.event.type)
          if (types.length === 2) {
            clearTimeout(timer)
            resolve(types)
          }
        })
        ws.on("error", reject)
      })
      assert.deepEqual(replayed, ["replay-two", "replay-three"])
    } finally {
      ws.close()
      await close()
    }
  })

  it("replays and filters independent v2 streams", async () => {
    const eventHub = new EventHub(10)
    const one = { kind: "session" as const, id: "one" }
    const two = { kind: "session" as const, id: "two" }
    const oneCursor = eventHub.getCursorV2(one)
    const twoCursor = eventHub.getCursorV2(two)
    eventHub.publishV2(one, "command.updated", { commandId: "one-command", sessionId: "one", status: "running" })
    eventHub.publishV2(two, "command.updated", { commandId: "two-command", sessionId: "two", status: "running" })

    const server = createAppServer({ authToken: null, eventHub })
    attachEventWebSocket(server, { authToken: null })
    const { port, close } = await listen(server)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, EVENT_WS_SUBPROTOCOL_V2)
    try {
      const commandIds = await new Promise<string[]>((resolve, reject) => {
        const received: string[] = []
        const timer = setTimeout(() => reject(new Error(`v2 replay timeout: ${received.join(",")}`)), 2000)
        ws.on("open", () => {
          assert.equal(ws.protocol, EVENT_WS_SUBPROTOCOL_V2)
          ws.send(JSON.stringify({
            type: "subscribe",
            protocolVersion: 2,
            streams: [one],
            cursors: { [eventStreamKeyV2(one)]: oneCursor, [eventStreamKeyV2(two)]: twoCursor },
          }))
        })
        ws.on("message", data => {
          const message = JSON.parse(String(data)) as {
            channel?: string
            event?: { payload?: { commandId?: string } }
          }
          const commandId = message.event?.payload?.commandId
          if (message.channel !== "event" || !commandId) return
          received.push(commandId)
          clearTimeout(timer)
          resolve(received)
        })
        ws.on("error", reject)
      })
      assert.deepEqual(commandIds, ["one-command"])
    } finally {
      ws.close()
      await close()
    }
  })

  it("requests resync only for v2 streams with missing cursors", async () => {
    const eventHub = new EventHub()
    const session = { kind: "session" as const, id: "session-1" }
    const server = createAppServer({ authToken: null, eventHub })
    attachEventWebSocket(server, { authToken: null })
    const { port, close } = await listen(server)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, EVENT_WS_SUBPROTOCOL_V2)
    try {
      const control = await new Promise<{ reason?: string }>((resolve, reject) => {
        ws.on("open", () => {
          ws.send(JSON.stringify({ type: "subscribe", protocolVersion: 2, streams: [session], cursors: {} }))
        })
        ws.on("message", data => {
          const message = JSON.parse(String(data)) as {
            channel?: string
            streams?: Record<string, { reason?: string }>
          }
          if (message.channel !== "control") return
          resolve(message.streams?.[eventStreamKeyV2(session)] ?? {})
        })
        ws.on("error", reject)
      })
      assert.equal(control.reason, "missing_cursor")
    } finally {
      ws.close()
      await close()
    }
  })

  it("rejects non-local browser origins", async () => {
    const server = createAppServer({ authToken: null })
    attachEventWebSocket(server, { authToken: null })
    const { port, close } = await listen(server)
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
        headers: { origin: "https://example.test" },
      })
      const error = await new Promise<Error>(resolve => ws.on("error", resolve))
      assert.match(error.message, /Unexpected server response: 403/)
      ws.close()
    } finally {
      await close()
    }
  })

  it("requires the configured token", async () => {
    const server = createAppServer({ authToken: "test-token" })
    attachEventWebSocket(server, { authToken: "test-token" })
    const { port, close } = await listen(server)
    try {
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
      const rejection = await new Promise<Error>(resolve => rejected.on("error", resolve))
      assert.match(rejection.message, /Unexpected server response: 403/)

      const wrongToken = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=nope`)
      const wrongRejection = await new Promise<Error>(resolve => wrongToken.on("error", resolve))
      assert.match(wrongRejection.message, /Unexpected server response: 403/)

      // Browsers cannot set handshake headers, so the query token is supported.
      const accepted = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=test-token`)
      await new Promise<void>((resolve, reject) => {
        accepted.on("open", resolve)
        accepted.on("error", reject)
      })
      accepted.close()
    } finally {
      await close()
    }
  })

  it("terminates connected clients during event server shutdown", async () => {
    const server = createAppServer({ authToken: null })
    const eventServer = attachEventWebSocket(server, { authToken: null })
    const { port, close } = await listen(server)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    })
    const clientClosed = new Promise<void>(resolve => ws.once("close", () => resolve()))
    const eventsClosed = new Promise<void>((resolve, reject) => {
      closeEventWebSocket(eventServer, error => (error ? reject(error) : resolve()))
    })

    await Promise.all([clientClosed, eventsClosed])
    assert.equal(eventServer.clients.size, 0)
    await close()
  })
})
