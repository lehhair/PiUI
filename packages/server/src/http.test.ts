import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAppServer, type AppServer } from "./http.ts"

async function listen(app: AppServer) {
  await new Promise<void>((resolve, reject) => {
    app.server.listen(0, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve()))
  })
  const addr = app.server.address()
  if (!addr || typeof addr === "string") throw new Error("no port")
  return addr.port
}

async function request(
  port: number,
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

describe("http api", () => {
  const cleanups: Array<() => Promise<void> | void> = []
  after(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it("rejects requests without a token and accepts a valid one", async () => {
    const app = createAppServer({ authToken: "test-token" })
    const port = await listen(app)
    cleanups.push(() => app.dispose())

    const rejected = await request(port, "GET", "/api/v1/host/health")
    assert.equal(rejected.status, 401)

    const accepted = await request(port, "GET", "/api/v1/host/health", { token: "test-token" })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.ok, true)
    assert.equal(accepted.json.service, "piui-server")
  })

  it("serves workspaces, files and git through the host surface", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "piui-http-host-"))
    writeFileSync(path.join(root, "hello.txt"), "hello piui", "utf8")
    mkdirSync(path.join(root, "src"))
    writeFileSync(path.join(root, "src", "index.ts"), "export const answer = 42\n", "utf8")
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(root, { recursive: true, force: true })
    })

    const created = await request(port, "POST", "/api/v1/host/workspaces", { body: { rootPath: root } })
    assert.equal(created.status, 201)
    const workspacePath = created.json.workspace.path as string

    const list = await request(port, "GET", "/api/v1/host/workspaces")
    assert.equal(list.status, 200)
    assert.ok(list.json.workspaces.some((ws: any) => ws.path === workspacePath))

    const encoded = encodeURIComponent(workspacePath)
    const dir = await request(port, "GET", `/api/v1/host/workspaces/${encoded}/files/list?path=`)
    assert.equal(dir.status, 200)
    assert.ok(dir.json.entries.some((entry: any) => entry.name === "hello.txt"))

    const read = await request(port, "GET", `/api/v1/host/workspaces/${encoded}/files/read?path=hello.txt`)
    assert.equal(read.status, 200)
    assert.equal(read.json.content, "hello piui")
    const etag = read.json.etag as string
    assert.ok(etag)

    const written = await request(port, "PUT", `/api/v1/host/workspaces/${encoded}/files/write?path=hello.txt`, {
      body: { content: "updated", ifMatch: etag },
    })
    assert.equal(written.status, 200)
    assert.equal(written.json.content, "updated")

    const stale = await request(port, "PUT", `/api/v1/host/workspaces/${encoded}/files/write?path=hello.txt`, {
      body: { content: "stale write", ifMatch: etag },
    })
    assert.equal(stale.status, 409)

    const search = await request(port, "GET", `/api/v1/host/workspaces/${encoded}/files/search-name?q=index`)
    assert.equal(search.status, 200)
    assert.ok(search.json.paths.some((p: string) => p.endsWith("index.ts")))

    const gitStatus = await request(port, "GET", `/api/v1/host/workspaces/${encoded}/git/status`)
    assert.equal(gitStatus.status, 200)

    const outside = await request(port, "GET", `/api/v1/host/workspaces/${encoded}/files/read?path=../outside.txt`)
    assert.ok([400, 403, 404].includes(outside.status))
  })

  it("serves catalog commands and reports unknown commands", async () => {
    const mockHome = mkdtempSync(path.join(tmpdir(), "piui-http-catalog-"))
    process.env.PIUI_MOCK_DIR = mockHome
    process.env.PIUI_DRIVER = "mock"
    const app = createAppServer({ authToken: null })
    const port = await listen(app)
    cleanups.push(async () => {
      await app.dispose()
      rmSync(mockHome, { recursive: true, force: true })
    })

    const registry = await request(port, "GET", "/api/v1/pi/registry")
    assert.equal(registry.status, 200)
    assert.equal(registry.json.revision, 1)
    const modelsList = registry.json.globalCommands.find((command: any) => command.name === "models.list")
    assert.equal(modelsList?.queue, "immediate")
    assert.equal(modelsList?.idempotent, true)
    assert.ok(registry.json.globalCommands.some((command: any) => command.name === "session.open"))
    const prompt = registry.json.sessionCommands.find((command: any) => command.name === "prompt")
    assert.equal(prompt?.paramsSchema.properties.text.type, "string")
    assert.equal(prompt?.streaming, true)

    const models = await request(port, "POST", "/api/v1/pi/commands/models.list")
    assert.equal(models.status, 200)
    assert.ok(models.json.data.some((model: any) => model.provider === "mock"))

    const settings = await request(port, "POST", "/api/v1/pi/commands/settings.get", { body: { cwd: mockHome } })
    assert.equal(settings.status, 200)

    const created = await request(port, "POST", "/api/v1/host/workspaces", { body: { rootPath: mockHome } })
    assert.equal(created.status, 201)
    const settingsNow = await request(port, "POST", "/api/v1/pi/commands/settings.get", { body: { cwd: mockHome } })
    assert.equal(settingsNow.status, 200)
    assert.equal(settingsNow.json.data.workspacePath, mockHome)

    const trust = await request(port, "POST", "/api/v1/pi/commands/trust.get", { body: { cwd: mockHome } })
    assert.equal(trust.status, 200)
    assert.equal(trust.json.data.trusted, true)

    const unknown = await request(port, "POST", "/api/v1/pi/commands/does.not.exist")
    assert.equal(unknown.status, 500)
    assert.equal(unknown.json.code, "UNKNOWN_COMMAND")

    const removedShortcut = await request(port, "GET", "/api/v1/pi/models")
    assert.equal(removedShortcut.status, 404)
  })
})
