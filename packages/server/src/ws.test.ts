import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { WebSocket } from "ws"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EVENT_WS_SUBPROTOCOL, eventStreamKey, type EventEnvelope } from "@piui/protocol"
import { createAppServer, type AppServer } from "./http.ts"
import { attachEventWebSocket, closeEventWebSocket } from "./ws.ts"
import type { WebSocketServer } from "ws"

async function listen(app: AppServer) {
  await new Promise<void>((resolve, reject) => {
    app.server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = app.server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  return addr.port
}

async function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

describe("event websocket", () => {
  const cleanups: Array<() => Promise<void> | void> = []
  after(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it("streams native Pi events for a mock session end to end", async () => {
    const mockHome = mkdtempSync(path.join(tmpdir(), "piui-ws-mock-"))
    process.env.PIUI_MOCK_DIR = mockHome
    process.env.PIUI_DRIVER = "mock"
    const app = createAppServer({ authToken: null })
    const wss: WebSocketServer = attachEventWebSocket(app.server, { eventHub: app.eventHub, authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      closeEventWebSocket(wss)
      await app.dispose()
      rmSync(mockHome, { recursive: true, force: true })
    })

    const health = await request(port, "GET", "/api/v1/host/health")
    assert.equal(health.status, 200)
    assert.equal(health.json.service, "piui-server")

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, EVENT_WS_SUBPROTOCOL)
    const envelopes: EventEnvelope[] = []
    const hello = new Promise<void>((resolve, reject) => {
      ws.once("message", () => resolve())
      ws.once("error", reject)
    })
    ws.on("message", data => {
      const message = JSON.parse(String(data))
      if (message.channel === "event") envelopes.push(message.event)
    })
    await hello

    const created = await request(port, "POST", "/api/v1/pi/sessions", { cwd: mockHome })
    assert.equal(created.status, 201)
    const sessionId = created.json.sessionId as string
    assert.ok(sessionId)

    ws.send(JSON.stringify({
      type: "subscribe",
      protocolVersion: 1,
      streams: [{ kind: "server", id: "server" }, { kind: "session", id: sessionId }],
      cursors: {},
    }))
    await new Promise(resolve => setTimeout(resolve, 100))

    const prompted = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands`, {
      id: "cmd-1",
      type: "prompt",
      params: { text: "hello mock" },
    })
    assert.equal(prompted.status, 202)
    assert.equal(prompted.json.command.status, "accepted")

    const deadline = Date.now() + 10_000
    let sawAgentEnd = false
    let sawCommandCompleted = false
    const piEventTypes = new Set<string>()
    while (Date.now() < deadline && (!sawAgentEnd || !sawCommandCompleted)) {
      for (const envelope of envelopes.splice(0)) {
        if (envelope.channel === "pi.event") {
          const piEvent = (envelope.payload as { event: { type: string } }).event
          piEventTypes.add(piEvent.type)
          if (piEvent.type === "agent_end") sawAgentEnd = true
        }
        if (envelope.channel === "command.updated" &&
          (envelope.payload as { status?: string }).status === "completed") {
          sawCommandCompleted = true
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    assert.ok(piEventTypes.has("agent_start"), `missing agent_start in ${[...piEventTypes]}`)
    assert.ok(piEventTypes.has("message_start"), `missing message_start in ${[...piEventTypes]}`)
    assert.ok(piEventTypes.has("message_end"), `missing message_end in ${[...piEventTypes]}`)
    assert.ok(sawAgentEnd, "did not see agent_end")
    assert.ok(sawCommandCompleted, "did not see command completion")

    const state = await request(port, "GET", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}`)
    assert.equal(state.status, 200)
    assert.equal(state.json.data.sessionId, sessionId)

    const branch = await request(port, "GET", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/branch`)
    assert.equal(branch.status, 200)
    assert.ok(branch.json.data.items.length >= 2)
    const roles = branch.json.data.items.map((entry: any) => entry.message?.role)
    assert.deepEqual(roles, ["user", "assistant"])

    const registry = await request(port, "GET", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/registry`)
    assert.equal(registry.status, 200)
    assert.ok(registry.json.data.tools.some((tool: any) => tool.name === "mock-tool"))

    const list = await request(port, "GET", "/api/v1/pi/sessions")
    assert.equal(list.status, 200)
    assert.ok(list.json.sessions.some((item: any) => item.id === sessionId), `sessions: ${JSON.stringify(list.json.sessions)} vs ${sessionId}`)
    assert.ok(list.json.attached.includes(sessionId))

    ws.close()
  })

  it("rejects connections without a valid token", async () => {
    const app = createAppServer({ authToken: "secret-token" })
    const wss: WebSocketServer = attachEventWebSocket(app.server, { eventHub: app.eventHub, authToken: "secret-token" })
    const port = await listen(app)
    cleanups.push(async () => {
      closeEventWebSocket(wss)
      await app.dispose()
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
    const closed = await new Promise<number>(resolve => {
      ws.on("close", code => resolve(code))
      ws.on("error", () => undefined)
    })
    assert.equal(closed, 1006)
  })
})
