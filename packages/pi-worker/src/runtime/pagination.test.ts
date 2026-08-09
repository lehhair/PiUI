import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, it } from "node:test"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const paginationEntry = fileURLToPath(new URL("./pagination.ts", import.meta.url))

function childScript(mode: "sign" | "verify"): string {
  const paginationImport = JSON.stringify(paginationEntry)
  if (mode === "sign") {
    return `
      import { entriesPageFromEntries, sessionHeadFromParts } from ${paginationImport}
      const head = sessionHeadFromParts({
        sessionId: "sess-1", sdkVersion: "0.84.0", revision: 1,
        sessionFormatVersion: 1, header: { sessionId: "sess-1" },
        leafId: "leaf", entryCount: 2,
      })
      const page = entriesPageFromEntries(
        head,
        [{ id: "a" }, { id: "b" }] as never,
        { limit: 1, maxBytes: 1024 * 1024 },
        (entry) => entry as never,
      )
      process.stdout.write(page.beforeCursor ?? "")
    `
  }
  return `
    import { entriesPageFromEntries, sessionHeadFromParts } from ${paginationImport}
    const cursor = process.env.CURSOR
    if (!cursor) { process.stdout.write("fail:no-cursor"); process.exit(0) }
    const head = sessionHeadFromParts({
      sessionId: "sess-1", sdkVersion: "0.84.0", revision: 1,
      sessionFormatVersion: 1, header: { sessionId: "sess-1" },
      leafId: "leaf", entryCount: 2,
    })
    try {
      const page = entriesPageFromEntries(
        head,
        [{ id: "a" }, { id: "b" }] as never,
        { cursor, limit: 1, maxBytes: 1024 * 1024 },
        (entry) => entry as never,
      )
      process.stdout.write("ok:" + String((page.items[0] as { id?: string }).id))
    } catch (error) {
      process.stdout.write("fail:" + String((error as { code?: string }).code))
    }
  `
}

function runChild(mode: "sign" | "verify", env: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "piui-cursor-"))
  roots.push(root)
  const script = path.join(root, `${mode}.ts`)
  writeFileSync(script, childScript(mode))
  return execFileSync(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  })
}

/**
 * 光标跨进程有效性：旧 bug 是每 worker 进程一个随机 HMAC 密钥，worker 重启
 * 后客户端旧光标全部 400。修复后服务端把持久化密钥经 PIUI_CURSOR_SECRET
 * 注入 worker 环境——"重启后的新 worker"（新进程、同密钥）必须能验证旧进程
 * 签发的光标；不共享密钥时则必须失败（旧行为）。
 */
describe("pagination cursor survives worker restarts", () => {
  it("validates a cursor signed by another process when sharing PIUI_CURSOR_SECRET", () => {
    const sharedSecret = Buffer.alloc(32, 7).toString("base64url")
    const cursor = runChild("sign", { PIUI_CURSOR_SECRET: sharedSecret })
    const result = runChild("verify", { PIUI_CURSOR_SECRET: sharedSecret, CURSOR: cursor })
    assert.equal(result, "ok:a")
  })

  it("rejects a cursor signed by another process without a shared secret", () => {
    const cursor = runChild("sign", { PIUI_CURSOR_SECRET: "" })
    const result = runChild("verify", { PIUI_CURSOR_SECRET: "", CURSOR: cursor })
    assert.equal(result, "fail:INVALID_REQUEST")
  })
})
