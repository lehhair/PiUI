import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { authTokenPath, piuiDataDir, resolveAuthToken } from "./auth-token.ts"

describe("local auth token", () => {
  const dirs: string[] = []
  const previousDataDir = process.env.PIUI_DATA_DIR
  const previousToken = process.env.PIUI_AUTH_TOKEN

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.PIUI_DATA_DIR
    else process.env.PIUI_DATA_DIR = previousDataDir
    if (previousToken === undefined) delete process.env.PIUI_AUTH_TOKEN
    else process.env.PIUI_AUTH_TOKEN = previousToken
  })

  function useTempDataDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "piui-auth-"))
    dirs.push(dir)
    process.env.PIUI_DATA_DIR = path.join(dir, "state")
    delete process.env.PIUI_AUTH_TOKEN
    return dir
  }

  it("generates a token once and reuses it across restarts", () => {
    useTempDataDir()
    const first = resolveAuthToken()
    assert.ok(first.length >= 32, "token must have enough entropy to resist guessing")

    // A restart must not invalidate clients that already read the token.
    assert.equal(resolveAuthToken(), first)
    assert.equal(readFileSync(authTokenPath(), "utf8").trim(), first)
  })

  it("keeps the token file unreadable to other users", () => {
    useTempDataDir()
    resolveAuthToken()
    if (process.platform === "win32") return // POSIX modes are not enforced here
    assert.equal(statSync(authTokenPath()).mode & 0o777, 0o600)
    assert.equal(statSync(piuiDataDir()).mode & 0o777, 0o700)
  })

  it("prefers an explicitly configured token", () => {
    useTempDataDir()
    process.env.PIUI_AUTH_TOKEN = "  configured-token  "
    assert.equal(resolveAuthToken(), "configured-token")
  })

  it("adopts a token written by another server that started first", () => {
    const dir = useTempDataDir()
    const file = path.join(dir, "state", "auth-token")
    resolveAuthToken() // creates the directory
    writeFileSync(file, "peer-token\n", "utf8")
    assert.equal(resolveAuthToken(), "peer-token")
  })

  it("regenerates when the stored token is empty", () => {
    useTempDataDir()
    const first = resolveAuthToken()
    writeFileSync(authTokenPath(), "   \n", "utf8")
    const second = resolveAuthToken()
    assert.notEqual(second, "")
    assert.notEqual(second, first)
  })
})
