import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const resources = join(root, "packages", "app", "src-tauri", "resources")

// Tauri 需要这些资源路径存在才能解析统一配置；Android 不启动 server，
// 因此这里只放空占位，不把桌面 runtime 带进 APK。
mkdirSync(join(resources, "runtime"), { recursive: true })
mkdirSync(join(resources, "node_modules"), { recursive: true })
mkdirSync(join(resources, "web"), { recursive: true })
writeFileSync(join(resources, "piui-server"), "")
writeFileSync(join(resources, "piui-server.exe"), "")
writeFileSync(join(resources, "piui-runtime.zip"), "")
writeFileSync(join(resources, "piui-runtime.version"), "mobile")

console.info(`[tauri] mobile resource placeholders prepared at ${resources}`)
