import { useState, useEffect, useMemo, useRef, useId, useSyncExternalStore } from 'react'
import type { ShikiThemeInput } from '../lib/shikiTheme'
import { getShikiTheme, useIsDarkMode } from '../lib/shikiTheme'
import { disposeShikiWorkerKey, highlightHtmlInWorker, highlightTokensInWorker } from '../lib/shikiWorkerClient'
import type { HighlightTokens } from '../lib/highlightTypes'
import { normalizeLanguage } from '../utils/languageUtils'
import { THEME_SWITCH_DISABLE_MS } from '../constants'
import { themeStore } from '../store/themeStore'

export type { HighlightTokens } from '../lib/highlightTypes'
export type { ShikiThemeInput } from '../lib/shikiTheme'

// ============================================
// 代码块主题订阅（仅在 codeBlockThemeLight/Dark 变化时触发 re-render）
// ============================================

function codeBlockThemeKey(): string {
  const s = themeStore.getState()
  return s.codeBlockThemeLight + '|' + s.codeBlockThemeDark
}

function useCodeBlockThemes(): { light: string; dark: string } {
  // 订阅派生字符串，避免其它 appearance 字段变化时让所有代码块重渲染
  useSyncExternalStore(themeStore.subscribe, codeBlockThemeKey)
  const s = themeStore.getState()
  return { light: s.codeBlockThemeLight, dark: s.codeBlockThemeDark }
}

type IdleWindowApi = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (id: number) => void
}

type HighlightTask = () => Promise<void>

// ============================================
// LRU 缓存层 - 避免重复高亮相同代码
// ============================================

interface CacheEntry<T> {
  value: T
  timestamp: number
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>()
  private maxSize: number

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (entry) {
      entry.timestamp = Date.now()
      return entry.value
    }
    return undefined
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.get(key)!.value = value
      this.cache.get(key)!.timestamp = Date.now()
      return
    }

    if (this.cache.size >= this.maxSize) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp
          oldestKey = k
        }
      }
      if (oldestKey) this.cache.delete(oldestKey)
    }

    this.cache.set(key, { value, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}

const htmlCache = new LRUCache<string>(120)
const tokensCache = new LRUCache<HighlightTokens>(80)

const highlightQueue: HighlightTask[] = []
let highlightQueueRunning = false
let highlightRequestId = 0

function scheduleQueuedHighlight(task: HighlightTask): () => void {
  let cancelled = false
  highlightQueue.push(async () => {
    if (!cancelled) await task()
  })
  void runHighlightQueue()

  return () => {
    cancelled = true
  }
}

async function runHighlightQueue() {
  if (highlightQueueRunning) return
  highlightQueueRunning = true

  try {
    while (highlightQueue.length > 0) {
      const task = highlightQueue.shift()
      if (task) await task()
      await yieldToMainThread()
    }
  } finally {
    highlightQueueRunning = false
  }
}

function yieldToMainThread(): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, 0)
  })
}

function getCacheKey(code: string, lang: string, theme: string): string {
  const codeHash = simpleHash(code)
  return `${codeHash}:${lang}:${theme}`
}

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return hash
}

async function highlightWithCache(
  code: string,
  lang: string,
  theme: ShikiThemeInput,
  themeKey: string,
  mode: 'html' | 'tokens',
): Promise<string | HighlightTokens | null> {
  const cacheKey = getCacheKey(code, lang, themeKey)

  if (mode === 'html') {
    const cached = htmlCache.get(cacheKey)
    if (cached !== undefined) return cached

    try {
      const { html } = await highlightHtmlInWorker({
        key: `html:${cacheKey}:${highlightRequestId++}`,
        text: code,
        language: lang,
        theme,
      })
      htmlCache.set(cacheKey, html)
      return html
    } catch {
      return null
    }
  } else {
    const cached = tokensCache.get(cacheKey)
    if (cached !== undefined) return cached

    try {
      const { tokens } = await highlightTokensInWorker({
        key: `tokens:${cacheKey}:${highlightRequestId++}`,
        text: code,
        language: lang,
        theme,
        complete: true,
      })
      tokensCache.set(cacheKey, tokens)
      return tokens
    } catch {
      return null
    }
  }
}

export function getHighlightCacheStats() {
  return {
    htmlCacheSize: htmlCache.size,
    tokensCacheSize: tokensCache.size,
  }
}

export function clearHighlightCache() {
  htmlCache.clear()
  tokensCache.clear()
}

export { getShikiTheme }

// ============================================
// Hooks
// ============================================

export interface HighlightOptions {
  lang?: string
  theme?: ShikiThemeInput
  enabled?: boolean
  delayMs?: number
}

/**
 * 流式语法高亮 —— 用于流式输出的代码块。
 * worker 侧已按 key latest-only；主线程再 rAF 合并 code，避免每 token 都 postMessage / setState。
 * 无缓存（流式内容每次都不同）；落后结果用 plain suffix 垫着（CodeBlock）。
 */
export function useStreamingSyntaxHighlight(
  code: string,
  options: HighlightOptions = {},
): { output: HighlightTokens | null; highlightedCode: string; isLoading: boolean } {
  const { lang = 'text', theme, enabled = true } = options
  const normalizedLang = normalizeLanguage(lang)
  const isDark = useIsDarkMode()
  const codeBlockThemes = useCodeBlockThemes()
  const instanceId = useId()
  const resolvedTheme = useMemo(() => {
    if (theme) return { theme, key: theme }
    return getShikiTheme(isDark, codeBlockThemes.light, codeBlockThemes.dark)
  }, [theme, isDark, codeBlockThemes.light, codeBlockThemes.dark])

  const [outputState, setOutputState] = useState<{ code: string; tokens: HighlightTokens } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const workerKeyRef = useRef('')
  const codeRef = useRef(code)
  codeRef.current = code

  const key = `${instanceId}:${normalizedLang}:${resolvedTheme.key}`

  useEffect(() => {
    if (!enabled) {
      if (workerKeyRef.current) {
        disposeShikiWorkerKey(workerKeyRef.current)
        workerKeyRef.current = ''
      }
      setIsLoading(false)
      return
    }

    let cancelled = false
    const previousKey = workerKeyRef.current
    if (previousKey && previousKey !== key) disposeShikiWorkerKey(previousKey)
    workerKeyRef.current = key

    // 同帧多次 code 变更只打一次 worker（读 codeRef 拿最新文本）
    const frame = requestAnimationFrame(() => {
      if (cancelled) return
      const text = codeRef.current
      setIsLoading(true)
      void highlightTokensInWorker({ key, text, language: normalizedLang, theme: resolvedTheme.theme })
        .then(result => {
          if (cancelled) return
          setOutputState(prev => (prev?.code === result.code ? prev : { code: result.code, tokens: result.tokens }))
        })
        .catch(err => {
          if (import.meta.env.DEV && err instanceof Error && err.message !== 'superseded') {
            console.warn('[Syntax] streaming Shiki worker error:', err)
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false)
        })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [code, enabled, key, normalizedLang, resolvedTheme.theme])

  useEffect(() => {
    return () => {
      if (workerKeyRef.current) disposeShikiWorkerKey(workerKeyRef.current)
    }
  }, [])

  const currentOutput = enabled && outputState && code.startsWith(outputState.code) ? outputState : null
  return {
    output: currentOutput?.tokens ?? null,
    highlightedCode: currentOutput?.code ?? '',
    isLoading: enabled && isLoading,
  }
}

// Overload for HTML mode (default)
export function useSyntaxHighlight(
  code: string,
  options?: HighlightOptions & { mode?: 'html' },
): { output: string | null; isLoading: boolean }
// Overload for Tokens mode
export function useSyntaxHighlight(
  code: string,
  options: HighlightOptions & { mode: 'tokens' },
): { output: HighlightTokens | null; isLoading: boolean }

export function useSyntaxHighlight(code: string, options: HighlightOptions & { mode?: 'html' | 'tokens' } = {}) {
  const { lang = 'text', theme, mode = 'html', enabled = true, delayMs = 0 } = options
  const normalizedLang = normalizeLanguage(lang)

  const isDark = useIsDarkMode()
  const codeBlockThemes = useCodeBlockThemes()

  const resolvedTheme = useMemo(() => {
    if (theme) {
      return { theme, key: theme }
    }
    return getShikiTheme(isDark, codeBlockThemes.light, codeBlockThemes.dark)
  }, [theme, isDark, codeBlockThemes.light, codeBlockThemes.dark])

  const cacheKey = useMemo(
    () => getCacheKey(code, normalizedLang, resolvedTheme.key),
    [code, normalizedLang, resolvedTheme.key],
  )
  const outputKey = `${mode}:${cacheKey}`
  const [outputState, setOutputState] = useState<{ key: string; value: string | HighlightTokens | null } | null>(() => {
    const cachedResult = mode === 'html' ? htmlCache.get(cacheKey) : tokensCache.get(cacheKey)
    return cachedResult !== undefined ? { key: outputKey, value: cachedResult } : null
  })
  const [isLoading, setIsLoading] = useState(false)
  const prevKeyRef = useRef<{ code: string; lang: string; themeKey: string } | null>(null)

  useEffect(() => {
    const cachedResult = mode === 'html' ? htmlCache.get(cacheKey) : tokensCache.get(cacheKey)
    if (cachedResult !== undefined) {
      setOutputState({ key: outputKey, value: cachedResult })
      setIsLoading(false)
      return
    }

    if (!enabled) {
      setIsLoading(false)
      return
    }

    let cancelled = false
    const prevKey = prevKeyRef.current
    const isThemeOnlyChange =
      !!prevKey && prevKey.code === code && prevKey.lang === normalizedLang && prevKey.themeKey !== resolvedTheme.key
    prevKeyRef.current = { code, lang: normalizedLang, themeKey: resolvedTheme.key }

    const shouldDefer = isThemeOnlyChange

    setIsLoading(true)

    async function highlight() {
      try {
        const result = await highlightWithCache(code, normalizedLang, resolvedTheme.theme, resolvedTheme.key, mode)
        if (!cancelled) setOutputState({ key: outputKey, value: result })
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn('[Syntax] Shiki error:', err)
        }
        if (!cancelled) setOutputState({ key: outputKey, value: null })
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    const schedule = () => {
      if (shouldDefer) {
        const idleWindow = window as Window & IdleWindowApi
        if (typeof idleWindow.requestIdleCallback === 'function') {
          const idleId = idleWindow.requestIdleCallback(
            () => {
              void highlight()
            },
            {
              timeout: THEME_SWITCH_DISABLE_MS * 2,
            },
          )
          return () => idleWindow.cancelIdleCallback?.(idleId)
        }
        const timeoutId = window.setTimeout(() => highlight(), THEME_SWITCH_DISABLE_MS)
        return () => clearTimeout(timeoutId)
      }
      if (delayMs > 0) {
        let cancelQueuedHighlight: (() => void) | null = null
        const timeoutId = window.setTimeout(() => {
          cancelQueuedHighlight = scheduleQueuedHighlight(highlight)
        }, delayMs)
        return () => {
          clearTimeout(timeoutId)
          cancelQueuedHighlight?.()
        }
      }
      return scheduleQueuedHighlight(highlight)
    }

    const cancelSchedule = schedule()

    return () => {
      cancelled = true
      cancelSchedule()
    }
  }, [cacheKey, code, delayMs, enabled, mode, normalizedLang, outputKey, resolvedTheme])

  return { output: outputState?.key === outputKey ? outputState.value : null, isLoading }
}

// ============================================
// Ref 版本 — tokens 不经过 React state/props
// 用于 CodePreview 等需要处理超大 token 数组的场景
// ============================================

export function useSyntaxHighlightRef(
  code: string,
  options: Omit<HighlightOptions, 'mode'> = {},
): { tokensRef: React.RefObject<HighlightTokens | null>; version: number } {
  const { lang = 'text', theme, enabled = true } = options
  const normalizedLang = normalizeLanguage(lang)

  const isDark = useIsDarkMode()
  const codeBlockThemes = useCodeBlockThemes()
  const resolvedTheme = useMemo(() => {
    if (theme) {
      return { theme, key: theme }
    }
    return getShikiTheme(isDark, codeBlockThemes.light, codeBlockThemes.dark)
  }, [theme, isDark, codeBlockThemes.light, codeBlockThemes.dark])

  const tokensRef = useRef<HighlightTokens | null>(null)
  const [version, setVersion] = useState(0)
  const prevKeyRef = useRef<{ code: string; lang: string; themeKey: string } | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let cancelled = false
    const prevKey = prevKeyRef.current
    const isThemeOnlyChange =
      !!prevKey && prevKey.code === code && prevKey.lang === normalizedLang && prevKey.themeKey !== resolvedTheme.key
    prevKeyRef.current = { code, lang: normalizedLang, themeKey: resolvedTheme.key }

    const shouldDefer = isThemeOnlyChange

    const cacheKey = getCacheKey(code, normalizedLang, resolvedTheme.key)
    const cachedResult = tokensCache.get(cacheKey)

    if (cachedResult !== undefined) {
      tokensRef.current = cachedResult
      setVersion(v => v + 1) // eslint-disable-line react-hooks/set-state-in-effect -- 缓存命中时需同步通知消费者
      return
    }

    if (!isThemeOnlyChange) {
      tokensRef.current = null
    }

    async function highlight() {
      try {
        const result = await highlightWithCache(code, normalizedLang, resolvedTheme.theme, resolvedTheme.key, 'tokens')
        if (!cancelled) {
          tokensRef.current = result as HighlightTokens | null
          setVersion(v => v + 1)
        }
      } catch (err) {
        if (import.meta.env.DEV) {
          console.warn('[Syntax] Shiki error:', err)
        }
        if (!cancelled) {
          tokensRef.current = null
          setVersion(v => v + 1)
        }
      }
    }

    const schedule = () => {
      if (shouldDefer) {
        const idleWindow = window as Window & IdleWindowApi
        if (typeof idleWindow.requestIdleCallback === 'function') {
          const idleId = idleWindow.requestIdleCallback(
            () => {
              void highlight()
            },
            { timeout: THEME_SWITCH_DISABLE_MS * 2 },
          )
          return () => idleWindow.cancelIdleCallback?.(idleId)
        }
        const timeoutId = window.setTimeout(() => highlight(), THEME_SWITCH_DISABLE_MS)
        return () => clearTimeout(timeoutId)
      }
      return scheduleQueuedHighlight(highlight)
    }

    const cancelSchedule = schedule()

    return () => {
      cancelled = true
      cancelSchedule()
    }
  }, [code, normalizedLang, resolvedTheme, enabled])

  return { tokensRef, version }
}
