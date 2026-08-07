import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundledLanguagesInfo } from 'shiki/langs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])])
const tauriDevHost = process.env.TAURI_DEV_HOST?.trim()

function katexWoff2Only() {
  return {
    name: 'katex-woff2-only',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/')
      if (!normalizedId.endsWith('/katex/dist/katex.min.css') && !normalizedId.endsWith('/katex/dist/katex.css')) {
        return null
      }

      return code.replace(
        /,url\(fonts\/KaTeX_[^)]+\.woff\) format\("woff"\),url\(fonts\/KaTeX_[^)]+\.ttf\) format\("truetype"\)/g,
        '',
      )
    },
  }
}

/**
 * The dev server proxies to the PiUI backend, which requires a local token.
 * Reading it here keeps the secret in Node: the browser never receives it, so
 * page scripts cannot exfiltrate it. Re-read per request so restarting the
 * backend does not require restarting Vite.
 */
function readBackendToken(): string | undefined {
  const configured = process.env.PIUI_AUTH_TOKEN?.trim()
  if (configured) return configured
  const dataDir = process.env.PIUI_DATA_DIR?.trim()
  const file = join(dataDir ? resolve(dataDir) : join(homedir(), '.piui'), 'auth-token')
  try {
    return readFileSync(file, 'utf-8').trim() || undefined
  } catch {
    return undefined
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
  },
  plugins: [katexWoff2Only(), react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return

          if (id.includes('@xterm/')) return 'vendor-terminal'
          // shiki core + engine + themes → 一个小 chunk；
          // 语言 grammar（@shikijs/langs/*）由 dynamic import 自动拆分
          if ((id.includes('shiki') || id.includes('@shikijs/')) && !id.includes('@shikijs/langs'))
            return 'vendor-shiki'
          if (id.includes('marked') || id.includes('dompurify') || id.includes('morphdom') || id.includes('katex')) return 'vendor-markdown'

          if (id.includes('@tauri-apps/')) return 'vendor-tauri'
        },
      },
    },
  },

  worker: {
    format: 'es',
  },

  // Tauri CLI 兼容：不清屏，让 Tauri 的日志能保留在终端
  clearScreen: false,

  server: {
    // Tauri mobile dev 需要通过网络访问 Vite dev server
    host: process.env.TAURI_DEV_HOST || false,
    // 普通 web dev 自动避让已占用端口；Tauri mobile 需要固定端口供原生壳连接
    strictPort: Boolean(tauriDevHost),
    // The proxy injects the local backend token, so only allow the explicit
    // host used by the Tauri dev bridge.
    allowedHosts: tauriDevHost ? [tauriDevHost] : [],

    proxy: {
      // Phase 1 server (no OpenCode). Will expand with /api/v1 routes.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on('proxyReq', proxyReq => {
            if (proxyReq.getHeader('authorization')) return
            const token = readBackendToken()
            if (token) proxyReq.setHeader('authorization', `Bearer ${token}`)
          })
          // WebSocket handshakes cannot carry headers from the browser, so the
          // token is attached on the upgrade request instead.
          proxy.on('proxyReqWs', proxyReq => {
            if (proxyReq.getHeader('authorization')) return
            const token = readBackendToken()
            if (token) proxyReq.setHeader('authorization', `Bearer ${token}`)
          })
        },
      },
    },
  },
})
