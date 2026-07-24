/**
 * Git status on a real temp repo via server (no LLM).
 */
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { after, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const PORT = 18789

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

describe("usable git status", () => {
  let child
  const wsRoot = mkdtempSync(path.join(tmpdir(), "piui-git-"))

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM")
    rmSync(wsRoot, { recursive: true, force: true })
  })

  it("reports modified file", async () => {
    git(wsRoot, ["init"])
    git(wsRoot, ["config", "user.email", "t@t.com"])
    git(wsRoot, ["config", "user.name", "t"])
    writeFileSync(path.join(wsRoot, "a.txt"), "one\n")
    git(wsRoot, ["add", "a.txt"])
    git(wsRoot, ["commit", "-m", "init"])
    writeFileSync(path.join(wsRoot, "a.txt"), "two\n")

    child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
      cwd: root,
      env: { ...process.env, PIUI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let ready = false
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/api/v1/health`)).ok) {
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
    const { workspace } = await reg.json()
    const st = await fetch(
      `http://127.0.0.1:${PORT}/api/v1/workspaces/${workspace.id}/git/status`,
    )
    assert.equal(st.status, 200)
    const body = await st.json()
    assert.ok(body.items.some(i => i.path === "a.txt" && i.status === "modified"))
  })
})
