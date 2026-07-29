/**
 * One-command dev: backend (tsx --watch) + frontend (vite HMR).
 * Any child exit stops the other and exits with the same code.
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const children = []
let exiting = false

function killTree(child) {
  if (child.killed || child.exitCode !== null) return
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    child.kill("SIGTERM")
  }
}

function shutdown(code) {
  if (exiting) return
  exiting = true
  for (const child of children) killTree(child)
  setTimeout(() => process.exit(code), 300)
}

function run(name, args, env = {}) {
  const child = spawn("npm", args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: true,
  })
  child.on("exit", code => {
    if (exiting) return
    console.log(`[dev] ${name} exited (${code ?? 0}), shutting down`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

run("server", ["run", "dev:server:pi"])
run("app", ["run", "dev:app"])

process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))
