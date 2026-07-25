import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { bundledLanguagesInfo } from 'shiki/langs'
import { fileURLToPath } from 'node:url'

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])])

export default defineConfig({
  define: {
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@opencode-ai/sdk/v2/client': fileURLToPath(new URL('./src/shims/opencode-sdk/v2/client.ts', import.meta.url)),
      '@opencode-ai/sdk': fileURLToPath(new URL('./src/shims/opencode-sdk/v2/client.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
})
