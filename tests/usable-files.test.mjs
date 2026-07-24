/**
 * Min usable: workspace register → list files → read file (no LLM)
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = 18788

describe("usable file tree", () => {
  let child
  const wsRoot = mkdtempSync(path.join(tmpdir(), "piui-files-"))
  mkdirSync(path.join(wsRoot, "src"))
  writeFileSync(path.join(wsRoot, "src", "hi.txt"), "hello usable\n")

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM")
    rmSync(wsRoot, { recursive: true, force: true })
  })

  it("list and read via live server", async () => {
    child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
      cwd: root,
      env: { ...process.env, PIUI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let ready = false
    for (let i = 0; i < 40; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`)
        if (h.ok) {
          ready = true
          break
        }
      } catch {
        /* wait */
      }
      await sleep(100)
    }
    assert.ok(ready)

    const reg = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rootPath: wsRoot }),
    })
    assert.equal(reg.status, 201)
    const { workspace } = await reg.json()

    const list = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/files?path=`,
    )
    assert.equal(list.status, 200)
    const listed = await list.json()
    assert.ok(listed.entries.some(e => e.name === "src"))

    const file = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/file?path=src/hi.txt`,
    )
    assert.equal(file.status, 200)
    const body = await file.json()
    assert.match(body.content, /hello usable/)
  })
})
