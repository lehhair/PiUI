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

test("closeWorkspace kills owned terminals and consumes their tickets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-close-"))
  const other = mkdtempSync(path.join(tmpdir(), "piui-terminal-close-other-"))
  const manager = new TerminalManager()
  try {
    const first = await manager.create(root, { title: "close-me" })
    const second = await manager.create(root, { title: "close-me-too" })
    const unrelated = await manager.create(other, { title: "keep-me" })
    const ticket = manager.issueConnectToken(root, first.id).token

    manager.closeWorkspace(root)

    assert.deepEqual(manager.list(root), [])
    assert.equal(manager.consumeConnectToken(first.id, ticket), undefined)
    assert.throws(() => manager.get(root, first.id), /not found/)
    assert.throws(() => manager.get(root, second.id), /not found/)
    assert.equal(manager.list(other).some(t => t.id === unrelated.id), true)
  } finally {
    manager.dispose()
    await removeWithRetry(root)
    await removeWithRetry(other)
  }
})

test("closing an already-closed workspace is a no-op", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-close-idem-"))
  const manager = new TerminalManager()
  try {
    await manager.create(root, { title: "still-running" })
    manager.closeWorkspace(root)
    manager.closeWorkspace(root)
    assert.deepEqual(manager.list(root), [])
  } finally {
    manager.dispose()
    await removeWithRetry(root)
  }
})

test("removing a terminal invalidates its connect ticket", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-ticket-"))
  const manager = new TerminalManager()
  try {
    const created = await manager.create(root, { title: "ticketed" })
    const ticket = manager.issueConnectToken(root, created.id).token
    manager.remove(root, created.id)
    assert.equal(manager.consumeConnectToken(created.id, ticket), undefined)
  } finally {
    manager.dispose()
    await removeWithRetry(root)
  }
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
