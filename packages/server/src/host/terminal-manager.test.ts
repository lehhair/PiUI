import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { extractTerminalTitle, TerminalManager } from "./terminal-manager.ts"

test("TerminalManager creates, streams, replays, and removes a terminal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-"))
  const manager = new TerminalManager()
  try {
    const created = await manager.create(root, { title: "Pi terminal", rows: 24, cols: 80 })
    assert.equal(created.status, "running")
    assert.equal(created.title, "Pi terminal")

    const output: string[] = []
    const titles: string[] = []
    const attachment = manager.attach(root, created.id, undefined, data => output.push(data), () => {}, title => titles.push(title))
    attachment.activate()
    manager.write(root, created.id, process.platform === "win32" ? "echo piui-terminal\r\n" : "printf piui-terminal\\n")
    await waitFor(() => output.join("").includes("piui-terminal"))

    const replayed = manager.attach(root, created.id, 0, () => {}, () => {})
    assert.match(replayed.replay, /piui-terminal/)
    replayed.detach()
    assert.match(output.join(""), /piui-terminal/)

    manager.update(root, created.id, { title: "Renamed terminal" })
    assert.deepEqual(titles, ["Renamed terminal"])
    manager.remove(root, created.id)
    assert.deepEqual(manager.list(root), [])
  } finally {
    manager.dispose()
    await removeWithRetry(root)
  }
})

test("extractTerminalTitle reads OSC 0 and OSC 2 titles", () => {
  assert.equal(extractTerminalTitle("\u001b]0;cmd.exe\u0007"), "cmd.exe")
  assert.equal(extractTerminalTitle("\u001b]2;PiUI project\u001b\\"), "PiUI project")
  assert.equal(extractTerminalTitle("ordinary output"), undefined)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for terminal exit")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function removeWithRetry(root: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  rmSync(root, { recursive: true, force: true })
}
