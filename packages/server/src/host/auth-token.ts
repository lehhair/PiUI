import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * PiUI's own state lives here, separate from `~/.pi/agent`, which belongs to
 * Pi and is shared with the CLI.
 */
export function piuiDataDir(): string {
  const override = process.env.PIUI_DATA_DIR?.trim()
  return override ? path.resolve(override) : path.join(homedir(), ".piui")
}

export function authTokenPath(): string {
  return path.join(piuiDataDir(), "auth-token")
}

/**
 * The server binds to loopback, but that only keeps other machines out: every
 * local process, including a browser running untrusted script, can still reach
 * it. Since the API reads and writes workspace files and runs bash, it needs a
 * shared secret rather than an open port.
 *
 * The token is persisted so restarting the server does not invalidate clients
 * that already read it. Delete the file to rotate.
 */
export function resolveAuthToken(): string {
  const fromEnv = process.env.PIUI_AUTH_TOKEN?.trim()
  if (fromEnv) return fromEnv

  const file = authTokenPath()
  const existing = readTokenFile(file)
  if (existing) return existing

  const token = randomBytes(32).toString("base64url")
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    // Exclusive create, so two servers starting together cannot each believe
    // they own a different token.
    writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return readTokenFile(file) ?? token
  }
}

function readTokenFile(file: string): string | undefined {
  try {
    const value = readFileSync(file, "utf8").trim()
    return value || undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function cursorSecretPath(): string {
  return path.join(piuiDataDir(), "cursor-secret")
}

/**
 * 分页光标的 HMAC 密钥，持久化到磁盘并在启动时注入 worker 环境。
 * worker 进程重启（空闲回收后重新 attach 会话）会重新生成各自的随机密钥，
 * 导致客户端旧光标全部 400（invalid pagination cursor）。持久化密钥让
 * 光标跨 worker 重启仍然有效。删除文件即可轮换。
 */
export function resolveCursorSecret(): string {
  const fromEnv = process.env.PIUI_CURSOR_SECRET?.trim()
  if (fromEnv) return fromEnv

  const file = cursorSecretPath()
  const existing = readTokenFile(file)
  if (existing) return existing

  const secret = randomBytes(32).toString("base64url")
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    // Exclusive create, so two servers starting together cannot each believe
    // they own a different secret.
    writeFileSync(file, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    return secret
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return readTokenFile(file) ?? secret
  }
}

/** 确保光标密钥已注入环境——必须在任何 worker spawn 之前调用。 */
export function ensureCursorSecretEnv(): string {
  const secret = resolveCursorSecret()
  process.env.PIUI_CURSOR_SECRET = secret
  return secret
}
