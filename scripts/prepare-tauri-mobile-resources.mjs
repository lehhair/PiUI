import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const resources = join(root, "packages", "app", "src-tauri", "resources")

// Android 不启动本地 server，只保留资源目录本身，不把桌面 runtime 带进 APK。
rmSync(resources, { recursive: true, force: true })
mkdirSync(resources, { recursive: true })
writeFileSync(join(resources, ".mobile-placeholder"), "")

console.info(`[tauri] mobile resource placeholders prepared at ${resources}`)
