import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = 18790

describe("usable search + write", () => {
  let child
  const wsRoot = mkdtempSync(path.join(tmpdir(), "piui-sw-"))
  mkdirSync(path.join(wsRoot, "src"))
  writeFileSync(path.join(wsRoot, "src", "note.md"), "v1\n")

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM")
    rmSync(wsRoot, { recursive: true, force: true })
  })

  it("search and put file", async () => {
    child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
      cwd: root,
      env: { ...process.env, PIUI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/api/v1/health`)).ok) break
      } catch {
        /* */
      }
      await sleep(100)
    }

    const reg = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: wsRoot }),
    })
    const { workspace } = await reg.json()

    const search = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/search/files?q=note`,
    )
    assert.equal(search.status, 200)
    const found = await search.json()
    assert.ok(found.paths.some(p => p.includes("note.md")))

    const read = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/file?path=src/note.md`,
    )
    const before = await read.json()

    const put = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/file?path=src/note.md`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "v2\n", ifMatch: before.etag }),
      },
    )
    assert.equal(put.status, 200)
    assert.equal(readFileSync(path.join(wsRoot, "src", "note.md"), "utf8"), "v2\n")

    const stale = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/file?path=src/note.md`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "v3\n", ifMatch: before.etag }),
      },
    )
    assert.equal(stale.status, 409)
  })
})
