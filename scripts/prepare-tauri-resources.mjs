import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packageDir = join(root, "packages", "app", "src-tauri")
const source = join(root, "dist-desktop")
const target = join(packageDir, "resources")

if (!existsSync(source)) {
  throw new Error("dist-desktop does not exist; run npm run package:desktop first")
}

const serverName = process.platform === "win32" ? "pi-worker.exe" : "pi-worker"
const server = join(source, serverName)
if (!existsSync(server)) throw new Error(`desktop server binary not found: ${server}`)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(server, join(target, serverName))
cpSync(join(source, "node_modules"), join(target, "node_modules"), { recursive: true })
for (const name of ["web", "theme", "assets", "export-html", "docs", "examples"]) {
  const path = join(source, name)
  if (existsSync(path)) cpSync(path, join(target, name), { recursive: true })
}
for (const name of ["package.json", "README.md", "CHANGELOG.md", "photon_rs_bg.wasm"]) {
  const path = join(source, name)
  if (existsSync(path)) cpSync(path, join(target, name))
}

console.info(`[tauri] resources prepared at ${target}`)
