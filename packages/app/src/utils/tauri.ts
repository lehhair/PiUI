// ============================================
// Tauri 平台检测 & 工具
// ============================================

/**
 * 检测当前是否运行在 Tauri 环境中
 * 通过检查 window.__TAURI_INTERNALS__ 来判断
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function isTauriMobile(): boolean {
  if (!isTauri() || typeof navigator === 'undefined') return false
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

// Tauri 下 HTTP 请求统一走 plugin-http（Rust reqwest）：WebView 的 fetch 会被系统
// 代理劫持，本地 127.0.0.1 服务在代理拦截下表现为 ERR_CONNECTION_REFUSED，
// 且浏览器会把每次网络失败打进控制台。加载结果缓存，避免重复 dynamic import。
let _tauriFetch: typeof globalThis.fetch | null = null
let _tauriFetchLoading: Promise<typeof globalThis.fetch> | null = null

export function getHttpFetch(): Promise<typeof globalThis.fetch> {
  if (!isTauri()) return Promise.resolve(globalThis.fetch.bind(globalThis))
  if (_tauriFetch) return Promise.resolve(_tauriFetch)
  if (_tauriFetchLoading) return _tauriFetchLoading
  _tauriFetchLoading = import('@tauri-apps/plugin-http').then(mod => {
    _tauriFetch = mod.fetch as unknown as typeof globalThis.fetch
    return _tauriFetch
  })
  return _tauriFetchLoading
}

export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'other'

export function getDesktopPlatform(): DesktopPlatform {
  if (!isTauri() || isTauriMobile() || typeof navigator === 'undefined') return 'other'

  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'macos'
  if (ua.includes('linux')) return 'linux'
  return 'other'
}

export function usesCustomDesktopTitlebar(): boolean {
  const platform = getDesktopPlatform()
  return platform === 'windows' || platform === 'macos'
}

/** 文件扩展名 → MIME 类型映射 */
export function extToMime(ext: string): string {
  const map: Record<string, string> = {
    // image
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    // pdf
    pdf: 'application/pdf',
    // audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    // video
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
  }
  return map[ext] || 'application/octet-stream'
}
