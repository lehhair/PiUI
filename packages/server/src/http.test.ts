import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
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
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
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
    const server = createAppServer({ authToken: null })
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
      assert.equal(data.protocolV2.capabilities.capabilities["session.delete"].enabled, true)
      assert.equal(data.protocolV2.capabilities.capabilities["session.tree"].enabled, true)
      // The mock driver has no Pi runtime, so replacement stays disabled and
      // the manifest has to say so instead of advertising a call that throws.
      assert.equal(data.protocolV2.capabilities.capabilities["session.fork"].enabled, false)
      assert.equal(data.protocolV2.capabilities.capabilities["session.navigate"].enabled, false)
    } finally {
      await close()
    }
  })

  it("scans only the requested workspace catalog", async () => {
    let scopedCwd: string | undefined
    let globalScans = 0
    const server = createAppServer({ authToken: null,
      driver: "pi",
      piBackend: {
        list: async cwd => {
          scopedCwd = cwd
          return []
        },
        listAll: async () => {
          globalScans += 1
          return []
        },
        open: async () => { throw new Error("not used") },
      },
    })
    const { port, close } = await listen(server)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(globalScans, 0)

      const workspace = await json(port, "POST", "/api/v1/workspaces", { rootPath: root })
      const workspacePath = workspace.data.workspace.path as string
      const sessions = await json(
        port,
        "GET",
        `/api/v1/sessions?workspacePath=${encodeURIComponent(workspacePath)}`,
      )
      assert.equal(sessions.status, 200)
      assert.equal(scopedCwd, path.resolve(root))
      assert.equal(globalScans, 0)
    } finally {
      await close()
    }
  })

  it("default workspace + local CORS preflight", async () => {
    const server = createAppServer({ authToken: null })
    const { port, close } = await listen(server)
    try {
      const origin = "http://localhost:5173"
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/default`, { headers: { origin } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get("access-control-allow-origin"), origin)
      const body = await res.json()
      assert.ok(body.workspace.path)

      const opt = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { method: "OPTIONS", headers: { origin } })
      assert.equal(opt.status, 204)
    } finally {
      await close()
    }
  })

  it("rejects non-local browser origins", async () => {
    const server = createAppServer({ authToken: null })
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
    const server = createAppServer({ authToken: "test-token" })
    const { port, close } = await listen(server)
    try {
      const missing = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      assert.equal(missing.status, 401)

      const command = await fetch(`http://127.0.0.1:${port}/api/v1/commands/private-command`)
      assert.equal(command.status, 401)

      const wrong = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { authorization: "Bearer nope" },
      })
      assert.equal(wrong.status, 401)

      const accepted = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { authorization: "Bearer test-token" },
      })
      assert.equal(accepted.status, 200)
    } finally {
      await close()
    }
  })

  it("rejects request bodies over the configured limit", async () => {
    const server = createAppServer({ authToken: null })
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
    const server = createAppServer({ authToken: null })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/workspaces", {
        rootPath: root,
        displayName: "test-ws",
      })
      assert.equal(created.status, 201)
      const workspacePath = created.data.workspace.path as string
      assert.equal(workspacePath, path.resolve(root))
      assert.equal(created.data.workspace.id, undefined, "workspace identity is the path itself")
      const encodedWorkspace = encodeURIComponent(workspacePath)

      const listed = await json(port, "GET", `/api/v1/workspaces/${encodedWorkspace}/files?path=`)
      assert.equal(listed.status, 200)
      const names = (listed.data.entries as { name: string }[]).map(e => e.name)
      assert.ok(names.includes("pkg"))

      const file = await json(port, "GET", `/api/v1/workspaces/${encodedWorkspace}/file?path=pkg/a.txt`)
      assert.equal(file.status, 200)
      assert.match(file.data.content, /hello phase1/)
      assert.ok(file.data.etag)

      const searched = await json(port, "GET", `/api/v1/workspaces/${encodedWorkspace}/search/text?q=phase1`)
      assert.equal(searched.status, 200)
      assert.equal(searched.data.matches[0].path.text, "pkg/a.txt")
      assert.equal(searched.data.matches[0].line_number, 1)

      const escape = await json(
        port,
        "GET",
        `/api/v1/workspaces/${encodedWorkspace}/file?path=${encodeURIComponent("../secret")}`,
      )
      assert.equal(escape.status, 403)
      assert.equal(escape.data.code, "PATH_OUTSIDE_WORKSPACE")

      const abs = await json(
        port,
        "GET",
        `/api/v1/workspaces/${encodedWorkspace}/file?path=${encodeURIComponent("C:/Windows/win.ini")}`,
      )
      assert.ok(abs.status >= 400)
    } finally {
      await close()
    }
  })

  it("supports the complete remote file lifecycle and structured search metadata", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "piui-http-files-"))
    const server = createAppServer({ authToken: null })
    const live = await listen(server)
    try {
      const createdWorkspace = await json(live.port, "POST", "/api/v1/workspaces", { rootPath: workspace })
      const encoded = encodeURIComponent(createdWorkspace.data.workspace.path)
      assert.equal((await json(live.port, "POST", `/api/v1/workspaces/${encoded}/files`, {
        path: "src", type: "directory",
      })).status, 201)
      const created = await json(live.port, "POST", `/api/v1/workspaces/${encoded}/files`, {
        path: "src/a.txt", type: "file", content: "hello remote",
      })
      assert.equal(created.status, 201)
      assert.equal(created.data.type, "text")

      const read = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/file?path=src%2Fa.txt`)
      assert.equal(read.data.content, "hello remote")
      const saved = await fetch(`http://127.0.0.1:${live.port}/api/v1/workspaces/${encoded}/file?path=src%2Fa.txt`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": read.data.etag },
        body: JSON.stringify({ content: "updated" }),
      })
      assert.equal(saved.status, 200)
      const stale = await fetch(`http://127.0.0.1:${live.port}/api/v1/workspaces/${encoded}/file?path=src%2Fa.txt`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": read.data.etag },
        body: JSON.stringify({ content: "stale" }),
      })
      assert.equal(stale.status, 409)
      assert.equal(((await stale.json()) as { code: string }).code, "STALE_REVISION")

      const moved = await json(live.port, "PATCH", `/api/v1/workspaces/${encoded}/file`, {
        from: "src/a.txt", to: "src/b.txt",
      })
      assert.equal(moved.data.path, "src/b.txt")
      const listing = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/files?path=src&limit=1`)
      assert.equal(listing.data.total, 1)
      assert.equal(listing.data.truncated, false)
      const names = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/search/files?q=b.txt`)
      assert.deepEqual(names.data.paths, ["src/b.txt"])
      assert.equal(names.data.stats.truncated, false)
      const textSearch = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/search/text?q=updated`)
      assert.equal(textSearch.data.matches[0].path.text, "src/b.txt")
      assert.ok(textSearch.data.stats.scannedBytes > 0)

      const removed = await fetch(
        `http://127.0.0.1:${live.port}/api/v1/workspaces/${encoded}/file?path=src%2Fb.txt`,
        { method: "DELETE" },
      )
      assert.equal(removed.status, 204)
      assert.equal((await json(live.port, "DELETE", `/api/v1/workspaces/${encoded}/file?path=src&recursive=true`)).status, 204)
    } finally {
      await live.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("does not auto-register an arbitrary workspace through a read route", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "piui-http-unregistered-"))
    writeFileSync(path.join(workspace, "secret.txt"), "secret")
    const server = createAppServer({ authToken: null })
    const live = await listen(server)
    try {
      const response = await json(
        live.port,
        "GET",
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/file?path=secret.txt`,
      )
      assert.equal(response.status, 404)
      assert.equal(response.data.code, "WORKSPACE_NOT_FOUND")
    } finally {
      await live.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("serves real Git status, list diff, and lazy file patches", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "piui-http-git-"))
    git(workspace, "init", "-b", "main")
    git(workspace, "config", "user.name", "PiUI Test")
    git(workspace, "config", "user.email", "piui@example.invalid")
    writeFileSync(path.join(workspace, "tracked.txt"), "base\n")
    git(workspace, "add", "tracked.txt")
    git(workspace, "commit", "-m", "initial")
    writeFileSync(path.join(workspace, "tracked.txt"), "base\nchanged\n")
    const server = createAppServer({ authToken: null })
    const live = await listen(server)
    try {
      const registered = await json(live.port, "POST", "/api/v1/workspaces", { rootPath: workspace })
      const encoded = encodeURIComponent(registered.data.workspace.path)
      const info = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/git/info`)
      assert.equal(info.data.branch, "main")
      assert.equal(info.data.defaultBranch, "main")
      const status = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/git/status`)
      assert.equal(status.data.items[0].status, "modified")
      const diff = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/git/diff?mode=git`)
      assert.equal(diff.data.files[0].status, "modified")
      const file = await json(
        live.port,
        "GET",
        `/api/v1/workspaces/${encoded}/git/file-diff?mode=git&path=tracked.txt`,
      )
      assert.match(file.data.patch, /^\+changed$/m)
      const invalid = await json(live.port, "GET", `/api/v1/workspaces/${encoded}/git/diff?mode=anything`)
      assert.equal(invalid.status, 400)
    } finally {
      await live.close()
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("accepts a commandId from either the header or the body", async () => {
    const server = createAppServer({ authToken: null })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "command ids" })
      const sessionId = created.data.session.id as string

      const viaHeader = await fetch(
        `http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/commands/set-thinking-level`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-command-id": "from-header" },
          body: JSON.stringify({ level: "high" }),
        },
      )
      assert.equal(viaHeader.status, 200)
      assert.equal((await viaHeader.json()).commandId, "from-header")

      // The body wins so a retried request keeps its identity even if a proxy
      // rewrites headers.
      const viaBoth = await fetch(
        `http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/commands/set-thinking-level`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-command-id": "from-header" },
          body: JSON.stringify({ level: "high", commandId: "from-body" }),
        },
      )
      assert.equal((await viaBoth.json()).commandId, "from-body")

      const blank = await json(port, "POST", `/api/v1/sessions/${sessionId}/commands/set-thinking-level`, {
        level: "high",
        commandId: "   ",
      })
      assert.equal(blank.status, 400)
      assert.equal(blank.data.code, "INVALID_REQUEST")
    } finally {
      await close()
    }
  })

  it("rejects malformed json instead of dropping the payload", async () => {
    const server = createAppServer({ authToken: null })
    const { port, close } = await listen(server)
    try {
      const created = await json(port, "POST", "/api/v1/sessions", { title: "bad json" })
      const sessionId = created.data.session.id as string

      // compact used to swallow this and run with no instructions at all.
      for (const route of ["compact", "abort", "set-name"]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/commands/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
        assert.equal(res.status, 400, `${route} accepted malformed json`)
        assert.equal((await res.json()).code, "INVALID_REQUEST")
      }

      const array = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/commands/compact`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      })
      assert.equal(array.status, 400)
    } finally {
      await close()
    }
  })

  it("reports method mismatches as 405 with an Allow header", async () => {
    const server = createAppServer({ authToken: null })
    const { port, close } = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/commands/anything`, { method: "POST" })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get("allow"), "GET")
      assert.equal((await res.json()).code, "METHOD_NOT_ALLOWED")

      const missing = await json(port, "GET", "/api/v1/commands/anything")
      assert.equal(missing.status, 404)
      assert.equal(missing.data.code, "NOT_FOUND")
    } finally {
      await close()
    }
  })

  it("separates unauthorized from forbidden", async () => {
    const server = createAppServer({ authToken: "test-token" })
    const { port, close } = await listen(server)
    try {
      const unauthorized = await json(port, "GET", "/api/v1/health")
      assert.equal(unauthorized.status, 401)
      assert.equal(unauthorized.data.code, "UNAUTHORIZED")

      const forbidden = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { origin: "https://example.test", authorization: "Bearer test-token" },
      })
      assert.equal(forbidden.status, 403)
      assert.equal((await forbidden.json()).code, "FORBIDDEN")
    } finally {
      await close()
    }
  })

  it("allows the methods and headers the client needs", async () => {
    const server = createAppServer({ authToken: null })
    const { port, close } = await listen(server)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173" },
      })
      assert.equal(res.status, 204)
      const methods = res.headers.get("access-control-allow-methods") ?? ""
      const headers = res.headers.get("access-control-allow-headers") ?? ""
      assert.ok(methods.includes("PATCH"), "pi-settings needs PATCH")
      assert.ok(headers.includes("x-command-id"), "command retries need x-command-id")
    } finally {
      await close()
    }
  })

  it("waits for backend cleanup before close completes", async () => {
    let release!: () => void
    const cleanup = new Promise<void>(resolve => { release = resolve })
    let closed = false
    const server = createAppServer({ authToken: null,
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
    const server = createAppServer({ authToken: null,
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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true })
}
