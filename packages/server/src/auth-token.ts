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
