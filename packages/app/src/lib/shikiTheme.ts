import { useState, useEffect } from 'react'
import type { BundledTheme } from 'shiki/themes'
import {
  DEFAULT_CODE_BLOCK_THEME_DARK,
  DEFAULT_CODE_BLOCK_THEME_LIGHT,
  normalizeCodeBlockTheme,
} from './codeBlockThemes'

export type ShikiThemeInput = BundledTheme

/**
 * 根据 isDark + 用户在设置里选择的代码块主题解析出实际使用的 Shiki 主题。
 * 入参为空字符串/无效值时回退到 GitHub Default。
 */
export function getShikiTheme(
  isDark: boolean,
  codeBlockThemeLight: string = DEFAULT_CODE_BLOCK_THEME_LIGHT,
  codeBlockThemeDark: string = DEFAULT_CODE_BLOCK_THEME_DARK,
): { theme: ShikiThemeInput; key: string } {
  const fallback = isDark ? DEFAULT_CODE_BLOCK_THEME_DARK : DEFAULT_CODE_BLOCK_THEME_LIGHT
  const requested = isDark ? codeBlockThemeDark : codeBlockThemeLight
  const theme = normalizeCodeBlockTheme(requested, fallback)
  return { theme, key: theme }
}

class ThemeStateManager {
  private isDark: boolean
  private subscribers = new Set<(isDark: boolean) => void>()
  private observer: MutationObserver | null = null
  private mediaQuery: MediaQueryList | null = null

  constructor() {
    this.isDark = this.detectTheme()
    this.setupListeners()
  }

  private detectTheme(): boolean {
    if (typeof window === 'undefined') return true
    const mode = document.documentElement.getAttribute('data-mode')
    if (mode === 'light') return false
    if (mode === 'dark') return true
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }

  private setupListeners() {
    if (typeof window === 'undefined') return

    this.observer = new MutationObserver(() => {
      const newIsDark = this.detectTheme()
      if (newIsDark !== this.isDark) {
        this.isDark = newIsDark
        this.notify()
      }
    })

    this.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mode'],
    })

    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    this.mediaQuery.addEventListener('change', () => {
      const mode = document.documentElement.getAttribute('data-mode')
      if (!mode || mode === 'system') {
        const newIsDark = this.mediaQuery!.matches
        if (newIsDark !== this.isDark) {
          this.isDark = newIsDark
          this.notify()
        }
      }
    })
  }

  private notify() {
    this.subscribers.forEach(fn => fn(this.isDark))
  }

  getIsDark(): boolean {
    return this.isDark
  }

  subscribe(fn: (isDark: boolean) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }
}

let themeStateManager: ThemeStateManager | null = null

function getThemeStateManager(): ThemeStateManager {
  if (!themeStateManager) themeStateManager = new ThemeStateManager()
  return themeStateManager
}

export function useIsDarkMode(): boolean {
  const manager = getThemeStateManager()
  const [isDark, setIsDark] = useState(() => manager.getIsDark())

  useEffect(() => manager.subscribe(setIsDark), [manager])

  return isDark
}
