import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const packageDir = join(root, "packages", "app", "src-tauri")
const source = join(root, "dist-desktop")
const target = join(packageDir, "resources")

if (!existsSync(source)) {
  throw new Error("dist-desktop does not exist; run npm run package:desktop first")
}

const serverName = process.platform === "win32" ? "piui-server.exe" : "piui-server"
const server = join(source, serverName)
if (!existsSync(server)) throw new Error(`desktop server binary not found: ${server}`)

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(server, join(target, serverName))
// 配置固定列出两个平台名，避免 Tauri 在另一平台解析不存在的 glob；
// Rust 启动器仍按当前平台优先选择正确的文件。
const alternateServerName = serverName === "piui-server.exe" ? "piui-server" : "piui-server.exe"
cpSync(server, join(target, alternateServerName))

const archive = join(target, "piui-runtime.zip")
const archiveName = "piui-runtime.zip"
rmSync(join(source, archiveName), { force: true })
const archiveResult = process.platform === "win32"
  ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path runtime,node_modules -DestinationPath '${archiveName}' -CompressionLevel Optimal -Force`], { cwd: source, stdio: "inherit" })
  : spawnSync("zip", ["-qr", archiveName, "runtime", "node_modules"], { cwd: source, stdio: "inherit" })
if (archiveResult.status !== 0) throw new Error("failed to create piui-runtime.zip")
cpSync(join(source, archiveName), archive)
rmSync(join(source, archiveName), { force: true })

const current = JSON.parse(readFileSync(join(source, "runtime", "current.json"), "utf8"))
const buildId = process.env.GITHUB_SHA ?? process.env.PIUI_RUNTIME_BUILD_ID ?? `local-${Date.now()}`
writeFileSync(join(target, "piui-runtime.version"), `${current.version ?? "unknown"}|${buildId}`)

console.info(`[tauri] resources prepared at ${target}`)
