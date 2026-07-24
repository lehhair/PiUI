import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { bundledLanguagesInfo } from "shiki/langs"

const root = fileURLToPath(new URL(".", import.meta.url))
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string }

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [
  info.id,
  ...(info.aliases ?? []),
])

function katexWoff2Only() {
  return {
    name: "katex-woff2-only",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const normalizedId = id.split("?")[0].replace(/\\/g, "/")
      if (
        !normalizedId.endsWith("/katex/dist/katex.min.css") &&
        !normalizedId.endsWith("/katex/dist/katex.css")
      ) {
        return null
      }
      return code.replace(
        /,url\(fonts\/KaTeX_[^)]+\.woff\) format\("woff"\),url\(fonts\/KaTeX_[^)]+\.ttf\) format\("truetype"\)/g,
        "",
      )
    },
  }
}

/** 浏览器：@tauri-apps/* 空实现 */
function tauriBrowserStubs(): Plugin {
  return {
    name: "tauri-browser-stubs",
    resolveId(id) {
      if (id.startsWith("@tauri-apps/")) return `\0tauri-stub:${id}`
      return null
    },
    load(id) {
      if (!id.startsWith("\0tauri-stub:")) return null
      return `
export async function invoke() { throw new Error('Tauri unavailable in browser') }
export async function openPath() {}
export async function openUrl(url) { if (typeof url === 'string') window.open(url, '_blank') }
export async function revealItemInDir() {}
export async function open() { return null }
export async function save() { return null }
export async function readFile() { throw new Error('fs unavailable') }
export async function writeFile() {}
export async function listen() { return () => {} }
export function getCurrentWindow() {
  return { startDragging: async () => {}, setTheme: async () => {} }
}
export class Channel { constructor() { this.onmessage = null } }
export const fetch = globalThis.fetch.bind(globalThis)
export async function isPermissionGranted() { return false }
export async function requestPermission() { return 'denied' }
export async function sendNotification() {}
export default {}
`
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
  },
  plugins: [katexWoff2Only(), react(), tailwindcss(), tauriBrowserStubs()],
  resolve: {
    alias: {
      // 去掉真实 OpenCode SDK，改走本地 shim
      "@opencode-ai/sdk/v2/client": resolve(root, "src/shims/opencode-sdk-client.ts"),
      "@opencode-ai/sdk": resolve(root, "src/shims/opencode-sdk-client.ts"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: { format: "es" },
})
