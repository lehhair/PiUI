import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import type { TerminalInfo } from "@piui/protocol"
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

test("lists available shells on the PTY host", async () => {
  const manager = new TerminalManager()
  try {
    const shells = await manager.listShells()
    assert.ok(shells.length > 0)
    assert.ok(shells.every(shell => shell.path && shell.name && typeof shell.acceptable === "boolean"))
    if (process.platform === "win32") assert.ok(shells.some(shell => shell.name === "bash"))
  } finally {
    manager.dispose()
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

test("attach rejects a future cursor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-future-"))
  const manager = new TerminalManager()
  try {
    const created = await manager.create(root, { title: "future" })
    manager.write(root, created.id, process.platform === "win32" ? "echo future-cursor\r\n" : "printf future-cursor\\n")
    await waitFor(() => manager.get(root, created.id).cursor > 0)
    const cursor = manager.get(root, created.id).cursor
    assert.throws(() => manager.attach(root, created.id, cursor + 10, () => {}, () => {}), (error: unknown) =>
      (error as { code?: string }).code === "INVALID_REQUEST")
  } finally {
    manager.dispose()
    await removeWithRetry(root)
  }
})

test("exited terminals replay buffered output and report the exit code", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-exited-replay-"))
  const manager = new TerminalManager()
  try {
    const created = await manager.create(root, { title: "replay" })
    // PTY 的回车提交在 macOS/Linux runner 上用 CR 更稳定；命令本身仍
    // 输出 LF，Windows cmd 使用 CRLF。
    manager.write(root, created.id, process.platform === "win32" ? "echo replay-me\r\n" : "printf replay-me\\n\r")
    await waitFor(() => manager.get(root, created.id).cursor > 0)
    manager.write(root, created.id, process.platform === "win32" ? "exit\r\n" : "exit\r")
    await waitFor(() => manager.get(root, created.id).status === "exited")
    assert.equal(manager.issueConnectToken(root, created.id).token.length > 0, true)

    let replayed = ""
    let exitCode: number | null | undefined
    const attachment = manager.attach(root, created.id, 0, data => (replayed += data), event => {
      exitCode = event.exitCode
    })
    assert.match(attachment.replay, /replay-me/)
    attachment.activate()
    assert.equal(exitCode, 0)
  } finally {
    manager.dispose()
    await removeWithRetry(root)
  }
})

test("enforces the terminal limit under concurrent creates", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piui-terminal-limit-"))
  const manager = new TerminalManager()
  try {
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => manager.create(root, { title: "limit" })))
    const ok = results.filter((result): result is PromiseFulfilledResult<TerminalInfo> => result.status === "fulfilled")
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
    assert.equal(ok.length, 32)
    assert.equal(failed.length, 8)
    for (const result of failed) {
      assert.equal((result.reason as { code?: string }).code, "TERMINAL_LIMIT_REACHED")
    }
  } finally {
    manager.dispose()
    await removeWithRetry(root)
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  // CI runner 负载高时 pty 退出信号会迟到，5s 不够用
  const deadline = Date.now() + 15_000
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
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EBUSY") throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  rmSync(root, { recursive: true, force: true })
}
