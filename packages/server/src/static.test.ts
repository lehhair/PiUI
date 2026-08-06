import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { createStaticServer, resolveStaticPath } from "./static.ts"

function withWebRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "piui-static-"))
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>")
    mkdirSync(join(root, "assets"), { recursive: true })
    writeFileSync(join(root, "assets", "app-a1b2c3d4.js"), "console.log(1)")
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("resolveStaticPath keeps requests inside the root", () => {
  withWebRoot(root => {
    assert.equal(resolveStaticPath(root, "/assets/app-a1b2c3d4.js"), join(root, "assets", "app-a1b2c3d4.js"))
    assert.equal(resolveStaticPath(root, "/%00"), undefined)
    // 各种形式的 .. 最终都不允许逃出 root（塌缩后落在 root 内也算安全）
    for (const attempt of ["/../etc/passwd", "/%2e%2e/%2e%2e/secret", "/..\\..\\secret", "/%2e%2e%5csecret"]) {
      const resolved = resolveStaticPath(root, attempt)
      if (resolved !== undefined) {
        assert.ok(
          resolved.startsWith(root),
          `${attempt} escaped the web root: ${resolved}`,
        )
      }
    }
  })
})

test("createStaticServer is undefined without an index.html", () => {
  const root = mkdtempSync(join(tmpdir(), "piui-static-empty-"))
  try {
    assert.equal(createStaticServer(root), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("unknown client routes fall back to index.html", async () => {
  await withWebRootAsync(root => collect(res => createStaticServer(root)!.serve(fakeRequest("GET"), res as never, "/sessions/abc")).then(served => {
    assert.equal(served.status, 200)
    assert.match(served.body, /app/)
    assert.equal(served.headers["cache-control"], "no-cache")
  }))
})

test("fingerprinted assets get immutable caching, missing files return false", async () => {
  const root = mkdtempSync(join(tmpdir(), "piui-static-"))
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>")
    mkdirSync(join(root, "assets"), { recursive: true })
    writeFileSync(join(root, "assets", "app-a1b2c3d4.js"), "console.log(1)")
    const server = createStaticServer(root)!
    const asset = await collect(res => server.serve(fakeRequest("GET"), res as never, "/assets/app-a1b2c3d4.js"))
    assert.equal(asset.status, 200)
    assert.match(asset.headers["cache-control"]!, /immutable/)
    assert.match(asset.headers["content-type"]!, /javascript/)
    assert.equal(server.serve(fakeRequest("GET"), fakeResponse() as never, "/missing.js"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("static hosting rejects directory links that leave the web root", () => {
  const root = mkdtempSync(join(tmpdir(), "piui-static-root-"))
  const outside = mkdtempSync(join(tmpdir(), "piui-static-outside-"))
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>")
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
    const server = createStaticServer(root)!
    assert.equal(server.serve(fakeRequest("GET"), fakeResponse() as never, "/linked/secret.txt"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

async function withWebRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "piui-static-"))
  try {
    writeFileSync(join(root, "index.html"), "<html>app</html>")
    mkdirSync(join(root, "assets"), { recursive: true })
    writeFileSync(join(root, "assets", "app-a1b2c3d4.js"), "console.log(1)")
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function fakeRequest(method: string) {
  return { method } as never
}

function fakeResponse() {
  const stream = new PassThrough()
  const res = stream as PassThrough & {
    status: number
    headers: Record<string, string>
    body: string
    writeHead: (status: number, headers: Record<string, string>) => unknown
  }
  res.status = 0
  res.headers = {}
  res.body = ""
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    return res
  }
  stream.on("data", chunk => {
    res.body += chunk.toString("utf8")
  })
  return res
}

async function collect(serve: (res: ReturnType<typeof fakeResponse>) => boolean) {
  const res = fakeResponse()
  const done = new Promise<void>(resolve => res.on("end", resolve))
  const handled = serve(res)
  if (handled) await done
  return res
}
