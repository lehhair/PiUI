import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { parseWebArgs, resolveServerConfig, startPiUiServer } from "./start.ts"

const roots: string[] = []
const previousDriver = process.env.PIUI_DRIVER

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (previousDriver === undefined) delete process.env.PIUI_DRIVER
  else process.env.PIUI_DRIVER = previousDriver
})

test("server config validates ports and parses web flags", () => {
  const config = resolveServerConfig({}, { webRoot: null })
  assert.equal(config.host, "127.0.0.1")
  assert.equal(config.port, 8787)
  assert.equal(config.webRoot, null)
  assert.throws(() => resolveServerConfig({ PIUI_PORT: "invalid" }, { webRoot: null }), /PIUI_PORT/)
  assert.deepEqual(parseWebArgs(["--host", "0.0.0.0", "--port=9000", "--api-only"]), {
    help: false,
    host: "0.0.0.0",
    port: 9000,
    webRoot: null,
  })
  assert.throws(() => parseWebArgs(["--unknown"]), /unknown|requires/)
})

test("one server provides the web app and authenticated API on the same port", async () => {
  process.env.PIUI_DRIVER = "mock"
  const webRoot = mkdtempSync(join(tmpdir(), "piui-start-web-"))
  roots.push(webRoot)
  writeFileSync(join(webRoot, "index.html"), "<html>piui</html>")
  const port = await availablePort()
  const running = await startPiUiServer(
    { host: "127.0.0.1", port, webRoot, authToken: "test-token" },
    { installSignalHandlers: false },
  )
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /piui/)

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/host/health`)
    assert.equal(unauthorized.status, 401)
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/host/health`, {
      headers: { authorization: "Bearer test-token" },
    })
    assert.equal(health.status, 200)
    assert.equal((await health.json() as { service?: string }).service, "piui-server")
  } finally {
    await running.stop()
  }
})

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}
