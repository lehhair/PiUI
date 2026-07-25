import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { createAppServer } from "./http.ts"
import { EventHub } from "./event-hub.ts"

async function listen(server: ReturnType<typeof createServer>) {
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

async function json(port: number, method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}

describe("session mock snapshot (no LLM)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-sess-"))
  after(() => rmSync(root, { recursive: true, force: true }))

  it("dev mock-chat seeds workspace + snapshot", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const res = await json(port, "POST", "/api/v1/dev/mock-chat")
      assert.equal(res.status, 201)
      assert.ok(res.data.workspace.id)
      assert.ok(res.data.snapshot.timeline.length >= 2)
    } finally {
      await close()
    }
  })

  it("create empty session, list, delete", async () => {
    const eventHub = new EventHub()
    const workspaceEvents: string[] = []
    eventHub.subscribeV2(event => {
      if (event.type === "workspace.sessions.updated") workspaceEvents.push(event.payload.sessionId ?? "")
    })
    const server = createAppServer({ eventHub })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "blank" })
      assert.equal(created.status, 201)
      assert.equal(created.data.snapshot.timeline.length, 0)
      const id = created.data.session.id as string
      assert.equal(created.data.snapshot.session.driverSessionId, id)
      assert.deepEqual(workspaceEvents, [id])

      const listed = await json(port, "GET", "/api/v1/sessions")
      assert.equal(listed.status, 200)
      assert.ok((listed.data.sessions as { id: string }[]).some(s => s.id === id))

      const del = await json(port, "DELETE", `/api/v1/sessions/${id}`)
      assert.equal(del.status, 200)
      assert.deepEqual(workspaceEvents, [id, id])
      const listed2 = await json(port, "GET", "/api/v1/sessions")
      assert.ok(!(listed2.data.sessions as { id: string }[]).some(s => s.id === id))
    } finally {
      await close()
    }
  })

  it("does not share in-memory sessions across server instances", async () => {
    const firstServer = createAppServer()
    const first = await listen(firstServer)
    try {
      const created = await json(first.port, "POST", "/api/v1/sessions", { title: "first server" })
      assert.equal(created.status, 201)
    } finally {
      await first.close()
    }

    const secondServer = createAppServer()
    const second = await listen(secondServer)
    try {
      const listed = await json(second.port, "GET", "/api/v1/sessions")
      assert.equal(listed.status, 200)
      assert.deepEqual(listed.data.sessions, [])
    } finally {
      await second.close()
    }
  })

  it("prompt appends mock turn without LLM", async () => {
    const eventHub = new EventHub()
    const snapshots: Array<{ reason: string; snapshot: { sequence: number; session: { title?: string } } }> = []
    eventHub.subscribeV2(event => {
      if (event.type === "session.snapshot.updated") snapshots.push(event.payload)
    })
    const server = createAppServer({ eventHub })
    const { port, close } = await listen(server)
    try {
      const seeded = await json(port, "POST", "/api/v1/dev/mock-chat")
      const sessionId = seeded.data.snapshot.session.id as string
      const before = seeded.data.snapshot.timeline.length as number

      const prompted = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, {
        text: "second turn",
      })
      assert.equal(prompted.status, 200)
      assert.equal(prompted.data.accepted, true)
      const after = prompted.data.snapshot.timeline as { type: string; text?: string }[]
      assert.ok(after.length > before)
      const lastUser = [...after].reverse().find(t => t.type === "user")
      assert.equal(lastUser?.text, "second turn")
      const lastAsst = [...after].reverse().find(t => t.type === "assistant")
      assert.ok(lastAsst)
      assert.equal(snapshots.at(-1)?.reason, "command")
      assert.equal(snapshots.at(-1)?.snapshot.sequence, prompted.data.snapshot.sequence)
      assert.equal(snapshots.at(-1)?.snapshot.session.title, "second turn")
    } finally {
      await close()
    }
  })

  it("returns native commands and skills as arrays", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "commands" })
      const sessionId = created.data.session.id as string
      const commands = await json(port, "GET", `/api/v1/sessions/${sessionId}/pi/commands`)
      const skills = await json(port, "GET", `/api/v1/sessions/${sessionId}/pi/skills`)
      assert.equal(commands.status, 200)
      assert.ok(Array.isArray(commands.data.commands))
      assert.equal(skills.status, 200)
      assert.ok(Array.isArray(skills.data.skills))
    } finally {
      await close()
    }
  })

  it("increments snapshot sequence for runtime state changes", async () => {
    const eventHub = new EventHub()
    const commandSnapshots: number[] = []
    eventHub.subscribeV2(event => {
      if (event.type === "session.snapshot.updated" && event.payload.reason === "command") {
        commandSnapshots.push(event.payload.snapshot.sequence)
      }
    })
    const server = createAppServer({ eventHub })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "sequence" })
      const sessionId = created.data.session.id as string
      const before = created.data.snapshot.sequence as number
      const changed = await json(
        port,
        "POST",
        `/api/v1/sessions/${sessionId}/commands/set-thinking-level`,
        { level: "high" },
      )
      assert.equal(changed.status, 200)
      assert.equal(changed.data.snapshot.sequence, before + 1)
      assert.deepEqual(commandSnapshots, [changed.data.snapshot.sequence])
    } finally {
      await close()
    }
  })

  it("reuses a prompt commandId without executing the turn twice", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "idempotent" })
      const sessionId = created.data.session.id as string
      const body = { text: "only once", commandId: "prompt-once" }

      const first = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, body)
      const second = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/prompt`, body)
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.equal(second.data.reused, true)
      const users = (second.data.snapshot.timeline as Array<{ type: string; text?: string }>)
        .filter(item => item.type === "user" && item.text === "only once")
      assert.equal(users.length, 1)

      const command = await json(port, "GET", "/api/v1/commands/prompt-once")
      assert.equal(command.status, 200)
      assert.equal(command.data.command.status, "completed")
    } finally {
      await close()
    }
  })

  it("creates session with projected timeline", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const ws = await json(port, "POST", "/api/v1/workspaces", { rootPath: root })
      assert.equal(ws.status, 201)
      const workspaceId = ws.data.workspace.id as string

      const created = await json(port, "POST", "/api/v1/sessions", {
        workspaceId,
        title: "demo",
        seedMock: true,
      })
      assert.equal(created.status, 201)
      const snap = created.data.snapshot
      assert.equal(snap.protocolVersion, 1)
      assert.equal(snap.session.driverId, "pi")
      assert.ok(Array.isArray(snap.timeline))
      assert.ok(snap.timeline.length >= 2)
      assert.equal(snap.timeline[0].type, "user")
      assert.equal(snap.timeline[1].type, "assistant")
      const tool = snap.timeline[1].content.find((c: { type: string }) => c.type === "tool")
      assert.ok(tool)
      assert.equal(tool.status, "completed")

      const sessionId = snap.session.id as string
      const again = await json(port, "GET", `/api/v1/sessions/${sessionId}/snapshot`)
      assert.equal(again.status, 200)
      assert.equal(again.data.session.id, sessionId)
      assert.equal(again.data.timeline.length, snap.timeline.length)
    } finally {
      await close()
    }
  })
})
