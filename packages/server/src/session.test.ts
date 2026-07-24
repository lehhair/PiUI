import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { createAppServer } from "./http.ts"

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
