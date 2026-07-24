import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { createAppServer } from "./http.ts"

async function listen(server: ReturnType<typeof createServer>): Promise<{ port: number; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  return {
    port: addr.port,
    close: () =>
      new Promise((resolve, reject) => {
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
  const data = await res.json()
  return { status: res.status, data }
}

describe("http phase1", () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-http-"))
  mkdirSync(path.join(root, "pkg"))
  writeFileSync(path.join(root, "pkg", "a.txt"), "hello phase1\n")

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("health", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const { status, data } = await json(port, "GET", "/api/v1/health")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.protocolVersion, 1)
      assert.equal(data.phase, 1)
    } finally {
      await close()
    }
  })

  it("register workspace, list and read files safely", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/workspaces", {
        rootPath: root,
        displayName: "test-ws",
      })
      assert.equal(created.status, 201)
      const id = created.data.workspace.id as string
      assert.ok(id)
      // absolute root must not appear in DTO
      assert.equal(created.data.workspace.canonicalRoot, undefined)
      assert.equal(created.data.workspace.rootPath, undefined)

      const listed = await json(port, "GET", `/api/v1/workspaces/${id}/files?path=`)
      assert.equal(listed.status, 200)
      const names = (listed.data.entries as { name: string }[]).map(e => e.name)
      assert.ok(names.includes("pkg"))

      const file = await json(port, "GET", `/api/v1/workspaces/${id}/file?path=pkg/a.txt`)
      assert.equal(file.status, 200)
      assert.match(file.data.content, /hello phase1/)
      assert.ok(file.data.etag)

      const escape = await json(
        port,
        "GET",
        `/api/v1/workspaces/${id}/file?path=${encodeURIComponent("../secret")}`,
      )
      assert.equal(escape.status, 403)
      assert.equal(escape.data.code, "PATH_OUTSIDE_WORKSPACE")

      const abs = await json(
        port,
        "GET",
        `/api/v1/workspaces/${id}/file?path=${encodeURIComponent("C:/Windows/win.ini")}`,
      )
      assert.ok(abs.status >= 400)
    } finally {
      await close()
    }
  })
})
