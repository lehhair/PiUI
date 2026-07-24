import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { bundledLanguagesInfo } from 'shiki/langs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }
const root = fileURLToPath(new URL('.', import.meta.url))
const sdkShim = fileURLToPath(new URL('./src/shims/opencode-sdk/v2/client.ts', import.meta.url))

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])])

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

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
  },
  plugins: [katexWoff2Only(), react(), tailwindcss()],
  resolve: {
    alias: {
      // Phase 3: no npm @opencode-ai/sdk. Phase 4 replaces data layer entirely.
      '@opencode-ai/sdk/v2/client': sdkShim,
      '@opencode-ai/sdk': sdkShim,
    },
  },
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
    // 避免端口冲突
    strictPort: true,
    // 允许所有域名
    allowedHosts: true,

    proxy: {
      // Phase 1 server (no OpenCode). Will expand with /api/v1 routes.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
