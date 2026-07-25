import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { createAppServer } from "./http.ts"
import { attachEventWebSocket } from "./ws.ts"
import { WebSocket } from "ws"

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
    const server = createAppServer()
    attachEventWebSocket(server)
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
      assert.equal(prompt.status, 200)

      // allow last events to flush
      await new Promise(r => setTimeout(r, 50))
      assert.ok(events.includes("session.snapshot"), `got events: ${events.join(",")}`)
      assert.ok(events.includes("session.updated"))
    } finally {
      ws?.close()
      await close()
    }
  })

  it("rejects non-local browser origins", async () => {
    const server = createAppServer()
    attachEventWebSocket(server)
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
    const previous = process.env.PIUI_AUTH_TOKEN
    process.env.PIUI_AUTH_TOKEN = "test-token"
    const server = createAppServer()
    attachEventWebSocket(server)
    const { port, close } = await listen(server)
    try {
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
      const rejection = await new Promise<Error>(resolve => rejected.on("error", resolve))
      assert.match(rejection.message, /Unexpected server response: 403/)

      const accepted = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=test-token`)
      await new Promise<void>((resolve, reject) => {
        accepted.on("open", resolve)
        accepted.on("error", reject)
      })
      accepted.close()
    } finally {
      await close()
      if (previous === undefined) delete process.env.PIUI_AUTH_TOKEN
      else process.env.PIUI_AUTH_TOKEN = previous
    }
  })
})
