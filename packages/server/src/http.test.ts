import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createConnection } from "node:net"
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
      assert.deepEqual(data.protocolV2.supportedProtocolVersions, [1, 2])
      assert.equal(data.protocolV2.piSdkVersion, "0.81.1")
      assert.equal(data.protocolV2.eventTransport.subprotocol, "piui.events.v2")
      assert.equal(data.protocolV2.capabilities.capabilities["session.open"].enabled, true)
      assert.equal(data.protocolV2.capabilities.capabilities["session.delete"].enabled, false)
    } finally {
      await close()
    }
  })

  it("default workspace + local CORS preflight", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const origin = "http://localhost:5173"
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/default`, { headers: { origin } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get("access-control-allow-origin"), origin)
      const body = await res.json()
      assert.ok(body.workspace.id)

      const opt = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { method: "OPTIONS", headers: { origin } })
      assert.equal(opt.status, 204)
    } finally {
      await close()
    }
  })

  it("rejects non-local browser origins", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/default`, {
        headers: { origin: "https://example.test" },
      })
      assert.equal(res.status, 403)
    } finally {
      await close()
    }
  })

  it("requires the configured bearer token", async () => {
    const previous = process.env.PIUI_AUTH_TOKEN
    process.env.PIUI_AUTH_TOKEN = "test-token"
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      assert.equal(missing.status, 401)

      const command = await fetch(`http://127.0.0.1:${port}/api/v1/commands/private-command`)
      assert.equal(command.status, 401)

      const accepted = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { authorization: "Bearer test-token" },
      })
      assert.equal(accepted.status, 200)
    } finally {
      await close()
      if (previous === undefined) delete process.env.PIUI_AUTH_TOKEN
      else process.env.PIUI_AUTH_TOKEN = previous
    }
  })

  it("rejects request bodies over the configured limit", async () => {
    const server = createAppServer()
    const { port, close } = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPath: "x".repeat(1024 * 1024) }),
      })
      assert.equal(res.status, 413)
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

      const searched = await json(port, "GET", `/api/v1/workspaces/${id}/search/text?q=phase1`)
      assert.equal(searched.status, 200)
      assert.equal(searched.data.matches[0].path.text, "pkg/a.txt")
      assert.equal(searched.data.matches[0].line_number, 1)

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

  it("waits for backend cleanup before close completes", async () => {
    let release!: () => void
    const cleanup = new Promise<void>(resolve => { release = resolve })
    let closed = false
    const server = createAppServer({
      driver: "pi",
      piBackend: {
        listAll: async () => [],
        open: async () => { throw new Error("not used") },
        dispose: async () => cleanup,
      },
    })
    await listen(server)
    const closing = new Promise<void>((resolve, reject) => {
      server.close(error => {
        closed = true
        if (error) reject(error)
        else resolve()
      })
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    release()
    await closing
    assert.equal(closed, true)
  })

  it("starts backend cleanup while an HTTP request is still open", async () => {
    let disposed = false
    const server = createAppServer({
      driver: "pi",
      piBackend: {
        listAll: async () => [],
        open: async () => { throw new Error("not used") },
        dispose: async () => { disposed = true },
      },
    })
    const { port } = await listen(server)
    const socket = createConnection({ host: "127.0.0.1", port })
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    socket.write("POST /api/v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{")

    const closing = new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(disposed, true)

    socket.destroy()
    await closing
  })
})
