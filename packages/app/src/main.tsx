import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import './i18n'
import { initOverlayScrollbars } from './lib/overlayScrollbar'
import App from './App.tsx'
import { DirectoryProvider, FullscreenProvider, SessionProvider } from './contexts'
import { themeStore } from './store/themeStore'
import { applyUrlTokenParam } from './store/serverStore'
import { isTauri, isTauriMobile } from './utils/tauri'
import { globalErrorHandler } from './utils/errorHandling'
import { serviceStore } from './store/serviceStore'

// Polyfill: randomUUID 在非 HTTPS 环境可能缺失（如局域网 HTTP）
// 统一补齐，避免业务层 scattered fallback。
function ensureRandomUUID() {
  const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string }
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return
  if (typeof cryptoObj.randomUUID === 'function') return

  cryptoObj.randomUUID = () => {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    // RFC 4122 v4
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  }
}

ensureRandomUUID()

// 服务器托管页面的入口链接带 ?token=（局域网/纯网页访问），落进 serverStore
// 后立刻从地址栏抹掉，token 不留在历史和书签里
if (applyUrlTokenParam(window.location.search, window.location.origin)) {
  window.history.replaceState(null, '', window.location.pathname)
}

// 禁用浏览器的 scroll restoration（刷新时不恢复旧 scrollTop），
// 由 ChatArea 自行控制定位
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual'
}

// 初始化主题系统（在 React 渲染前注入 CSS 变量，避免闪烁）
themeStore.init()

// 全局 overlay 滚动条 — 等 DOM 就绪后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initOverlayScrollbars)
} else {
  // DOM 已就绪（defer script 或者 module）
  requestAnimationFrame(initOverlayScrollbars)
}

const isNativeTauri = isTauri()

function configureNativeShell() {
  if (!isNativeTauri) return

  // 添加 CSS class 用于 safe-area 适配
  document.documentElement.classList.add('tauri-app')

  // 确保 viewport meta 包含 viewport-fit=cover（用于状态栏沉浸式）
  const viewportMeta = document.querySelector('meta[name="viewport"]')
  if (!viewportMeta) return

  const content = viewportMeta.getAttribute('content') || ''
  if (!content.includes('viewport-fit=cover')) {
    viewportMeta.setAttribute('content', content + ', viewport-fit=cover')
  }
}

configureNativeShell()

// 全局错误处理 - 防止未捕获错误导致页面刷新
window.addEventListener('error', event => {
  globalErrorHandler('uncaught error', event.error)
  event.preventDefault()
})

window.addEventListener('unhandledrejection', event => {
  globalErrorHandler('unhandled promise rejection', event.reason)
  event.preventDefault()
})

const root = createRoot(document.getElementById('root')!)

function bootstrap() {
  root.render(
    <StrictMode>
      <Suspense fallback={null}>
        <DirectoryProvider>
          <SessionProvider>
            <FullscreenProvider>
              <App />
            </FullscreenProvider>
          </SessionProvider>
        </DirectoryProvider>
      </Suspense>
    </StrictMode>,
  )
}

async function startNativePiuiService(): Promise<void> {
  if (!isNativeTauri || isTauriMobile() || !serviceStore.autoStart) return
  const { startDesktopService } = await import('./services/desktopService')
  const { result } = await startDesktopService()
  console.info(`[PiUI] local server ${result.started ? 'started by app' : 'already running'} at ${result.url}`)
}

async function startApp() {
  // Match the desktop shell behavior: render immediately, then bring the
  // managed service up in the background. Backend bootstrap retries while the
  // service starts and server changes trigger an immediate reconnect.
  bootstrap()

  const { initializePiBackend, installPiBackendServerSwitch } = await import('./pi/bootstrapMockChat')
  installPiBackendServerSwitch()

  if (isNativeTauri && !isTauriMobile()) {
    void startNativePiuiService().catch(error => {
      console.error('[PiUI] auto-start local server failed:', error)
    })
  }

  const backend = await initializePiBackend()
  if (isNativeTauri) {
    console.info('[PiUI] native shell — PiUI server lifecycle is managed by Tauri')
  } else if (!backend.available) {
    console.info('[PiUI] browser shell — PiUI server unavailable')
  }
}

void startApp()
