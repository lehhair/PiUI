import assert from "node:assert/strict"
import { after, describe, it } from "node:test"

// Parallel test files each spawn SDK workers; the default handshake budget
// is too tight when several spawn at once on a loaded machine.
process.env.PIUI_WORKER_HANDSHAKE_TIMEOUT_MS ??= "60000"

import { WebSocket } from "ws"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EVENT_WS_SUBPROTOCOL, eventStreamKey, type EventEnvelope } from "@piui/protocol"
import { createAppServer, type AppServer } from "./http.ts"
import { attachEventWebSocket, closeEventWebSocket } from "./ws.ts"
import type { WebSocketServer } from "ws"

// 测试进程的 session 租约目录放进独立临时目录，跑完即删，
// 不污染默认的 piui-session-leases 命名空间。
const leaseHome = mkdtempSync(path.join(tmpdir(), "piui-ws-leases-"))
process.env.PIUI_SESSION_LEASE_DIR = leaseHome
after(() => {
  rmSync(leaseHome, { recursive: true, force: true })
})

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

    const created = await request(port, "POST", "/api/v1/pi/commands/session.open", { cwd: mockHome })
    assert.equal(created.status, 200)
    const sessionId = created.json.data.sessionId as string
    assert.ok(sessionId)

    ws.send(JSON.stringify({
      type: "subscribe",
      protocolVersion: 1,
      streams: [{ kind: "server", id: "server" }, { kind: "session", id: sessionId }],
      cursors: {},
    }))
    await new Promise(resolve => setTimeout(resolve, 100))

    const prompted = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/prompt`, {
      id: "cmd-1",
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

    const state = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/state.get`)
    assert.equal(state.status, 200)
    assert.equal(state.json.data.sessionId, sessionId)
    // state.get 透传原生 stats/context usage（SDK getSessionStats/getContextUsage 形状）
    assert.equal(typeof state.json.data.sessionStats.totalMessages, "number")
    assert.equal(typeof state.json.data.sessionStats.tokens.total, "number")
    assert.equal(typeof state.json.data.sessionStats.cost, "number")
    assert.equal(typeof state.json.data.contextUsage.contextWindow, "number")
    assert.equal(typeof state.json.data.contextUsage.percent, "number")

    // exportJsonl / exportHtml：serialized session 命令 202 接受，
    // 完成后通过 command.updated 事件确认，落盘路径由命令结果返回
    const jsonlExport = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/exportJsonl`, {
      id: "cmd-export-jsonl",
      params: { outputPath: path.join(mockHome, "export.jsonl") },
    })
    assert.equal(jsonlExport.status, 202)
    assert.equal(jsonlExport.json.command.status, "accepted")
    await waitForCommand(ws, envelopes, "cmd-export-jsonl")
    assert.equal(existsSync(path.join(mockHome, "export.jsonl")), true)
    const htmlExport = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/exportHtml`, {
      id: "cmd-export-html",
      params: { outputPath: path.join(mockHome, "export.html") },
    })
    assert.equal(htmlExport.status, 202)
    assert.equal(htmlExport.json.command.status, "accepted")
    await waitForCommand(ws, envelopes, "cmd-export-html")
    assert.equal(existsSync(path.join(mockHome, "export.html")), true)

    const branch = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/branch.get`)
    assert.equal(branch.status, 200)
    assert.ok(branch.json.data.items.length >= 2)
    const roles = branch.json.data.items.map((entry: any) => entry.message?.role)
    assert.deepEqual(roles, ["user", "assistant"])

    const registry = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/registry.get`)
    assert.equal(registry.status, 200)
    assert.ok(registry.json.data.tools.some((tool: any) => tool.name === "mock-tool"))
    assert.equal(registry.json.data.tools.some((tool: any) => tool.name === "mock-dynamic-tool"), false)

    const dynamicCommand = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/invokeCommand`, {
      id: "cmd-dynamic-registry",
      params: { name: "mock-command" },
    })
    assert.equal(dynamicCommand.status, 202)
    let sawRegistryUpdated = false
    const registryDeadline = Date.now() + 5_000
    while (Date.now() < registryDeadline && !sawRegistryUpdated) {
      for (const envelope of envelopes.splice(0)) {
        if (envelope.channel === "registry.updated") {
          assert.equal((envelope.payload as { sessionId?: string }).sessionId, sessionId)
          assert.equal(typeof (envelope.payload as { revision?: unknown }).revision, "number")
          assert.equal((envelope.payload as { reason?: string }).reason, "command:invokeCommand")
          sawRegistryUpdated = true
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(sawRegistryUpdated, "did not see registry.updated")

    const changedRegistry = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/registry.get`)
    assert.equal(changedRegistry.status, 200)
    assert.ok(changedRegistry.json.data.tools.some((tool: any) => tool.name === "mock-dynamic-tool"))

    const dynamicTool = await request(port, "POST", `/api/v1/pi/sessions/${encodeURIComponent(sessionId)}/commands/invokeTool`, {
      id: "cmd-dynamic-tool",
      params: { name: "mock-dynamic-tool", arguments: { value: "ok" } },
    })
    assert.equal(dynamicTool.status, 202)

    const list = await request(port, "POST", "/api/v1/pi/commands/session.listAll")
    assert.equal(list.status, 200)
    assert.ok(list.json.data.some((item: any) => item.id === sessionId), `sessions: ${JSON.stringify(list.json.data)} vs ${sessionId}`)

    const attached = await request(port, "POST", "/api/v1/pi/commands/session.attached")
    assert.equal(attached.status, 200)
    assert.ok(attached.json.data.includes(sessionId))

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

    const accepted = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${encodeURIComponent("secret-token")}`)
    await new Promise<void>((resolve, reject) => {
      accepted.once("open", () => resolve())
      accepted.once("error", reject)
    })
    accepted.close()
  })

  it("streams terminal replay, input, and exit frames through a one-time ticket", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-terminal-"))
    const app = createAppServer({ authToken: null })
    const wss: WebSocketServer = attachEventWebSocket(app.server, {
      eventHub: app.eventHub,
      authToken: null,
      terminalManager: app.terminals,
    })
    const port = await listen(app)
    cleanups.push(async () => {
      closeEventWebSocket(wss)
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const opened = await request(port, "POST", "/api/v1/host/commands/workspaces.open", { rootPath: root })
    const workspacePath = opened.json.data.workspace.path as string
    const created = await request(port, "POST", "/api/v1/host/commands/terminals.create", {
      workspacePath,
      title: "Stream terminal",
    })
    assert.equal(created.status, 200)
    const terminalId = created.json.data.id as string
    const ticketResponse = await request(port, "POST", "/api/v1/host/commands/terminals.connectToken", {
      workspacePath,
      terminalId,
    })
    assert.equal(ticketResponse.status, 200)
    const ticket = ticketResponse.json.data.token as string

    const frames: any[] = []
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/host/terminals/${encodeURIComponent(terminalId)}/stream?ticket=${encodeURIComponent(ticket)}`,
    )
    ws.on("message", data => frames.push(JSON.parse(String(data))))
    await waitFor(() => frames.some(frame => frame.type === "ready"))
    ws.send(JSON.stringify({ type: "input", data: process.platform === "win32" ? "echo piui-ws\r\n" : "printf piui-ws\\n" }))
    await waitFor(() => frames.some(frame => frame.type === "output" && frame.data.includes("piui-ws")))
    ws.send(JSON.stringify({ type: "input", data: process.platform === "win32" ? "exit\r\n" : "exit\n" }))
    await waitFor(() => frames.some(frame => frame.type === "exit"))
    assert.equal(frames[0]?.type, "hello")
    assert.equal(frames[1]?.type, "ready")
    ws.close()
  })

  it("cleans up terminals when a workspace is closed and reopened", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-terminal-close-"))
    const app = createAppServer({ authToken: null })
    const wss: WebSocketServer = attachEventWebSocket(app.server, {
      eventHub: app.eventHub,
      authToken: null,
      terminalManager: app.terminals,
    })
    const port = await listen(app)
    cleanups.push(async () => {
      closeEventWebSocket(wss)
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const opened = await request(port, "POST", "/api/v1/host/commands/workspaces.open", { rootPath: root })
    const workspacePath = opened.json.data.workspace.path as string
    const created = await request(port, "POST", "/api/v1/host/commands/terminals.create", {
      workspacePath,
      title: "close-me",
    })
    assert.equal(created.status, 200)
    const terminalId = created.json.data.id as string
    const beforeClose = await request(port, "POST", "/api/v1/host/commands/terminals.list", { workspacePath })
    assert.equal(beforeClose.status, 200)
    assert.deepEqual(beforeClose.json.data.terminals.map((t: any) => t.id), [terminalId])

    const closed = await request(port, "POST", "/api/v1/host/commands/workspaces.close", { workspacePath })
    assert.equal(closed.status, 200)
    const afterClose = await request(port, "POST", "/api/v1/host/commands/terminals.list", { workspacePath })
    assert.notEqual(afterClose.status, 200)

    const reopened = await request(port, "POST", "/api/v1/host/commands/workspaces.open", { rootPath: root })
    const reopenedPath = reopened.json.data.workspace.path as string
    assert.equal(reopenedPath, workspacePath)
    const reopenedList = await request(port, "POST", "/api/v1/host/commands/terminals.list", { workspacePath: reopenedPath })
    assert.deepEqual(reopenedList.json.data.terminals, [])
  })

  it("reconnects to an exited terminal for replay and closes server-side", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-ws-terminal-reexit-"))
    const app = createAppServer({ authToken: null })
    const wss: WebSocketServer = attachEventWebSocket(app.server, {
      eventHub: app.eventHub,
      authToken: null,
      terminalManager: app.terminals,
    })
    const port = await listen(app)
    cleanups.push(async () => {
      closeEventWebSocket(wss)
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const opened = await request(port, "POST", "/api/v1/host/commands/workspaces.open", { rootPath: root })
    const workspacePath = opened.json.data.workspace.path as string
    const created = await request(port, "POST", "/api/v1/host/commands/terminals.create", { workspacePath })
    const terminalId = created.json.data.id as string

    const connect = async (): Promise<{ ws: WebSocket; frames: any[]; closed: Promise<void> }> => {
      const ticket = (await request(port, "POST", "/api/v1/host/commands/terminals.connectToken", { workspacePath, terminalId }))
        .json.data.token as string
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/host/terminals/${encodeURIComponent(terminalId)}/stream?ticket=${encodeURIComponent(ticket)}`,
      )
      const frames: any[] = []
      ws.on("message", data => frames.push(JSON.parse(String(data))))
      const closed = new Promise<void>(resolve => ws.on("close", () => resolve()))
      return { ws, frames, closed }
    }

    const first = await connect()
    await waitFor(() => first.frames.some(frame => frame.type === "ready"))
    first.ws.send(JSON.stringify({ type: "input", data: process.platform === "win32" ? "echo replay-ws\r\n" : "printf replay-ws\\n" }))
    first.ws.send(JSON.stringify({ type: "input", data: process.platform === "win32" ? "exit\r\n" : "exit\n" }))
    await waitFor(() => first.frames.some(frame => frame.type === "exit"))
    await first.closed

    const listed = await request(port, "POST", "/api/v1/host/commands/terminals.list", { workspacePath })
    assert.equal(listed.json.data.terminals[0].status, "exited")

    const second = await connect()
    await waitFor(() => second.frames.some(frame => frame.type === "ready"))
    await waitFor(() => second.frames.some(frame => frame.type === "exit"))
    const output = second.frames
      .filter(frame => frame.type === "output")
      .map(frame => frame.data as string)
      .join("")
    assert.match(output, /replay-ws/)
    await second.closed
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for websocket frame")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function waitForCommand(
  ws: WebSocket,
  envelopes: Array<{ channel: string; payload: unknown }>,
  commandId: string,
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const envelope of envelopes.splice(0)) {
      if (envelope.channel !== "command.updated") continue
      const payload = envelope.payload as { id?: string; status?: string }
      if (payload.id === commandId && payload.status === "completed") return
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`command ${commandId} did not complete`)
}
