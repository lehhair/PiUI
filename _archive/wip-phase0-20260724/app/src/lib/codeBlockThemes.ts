/**
 * Code block (Shiki) theme catalog + helpers.
 *
 * `bundledThemesInfo` 来自 `shiki/themes`，包含全部 65 个内置 Shiki 主题的
 * `{ id, displayName, type }` 元数据。Worker 端使用同源的 lazy `import` 字段
 * 按需加载，主线程只读元数据用于下拉菜单。
 */

import { bundledThemesInfo } from 'shiki/themes'
import type { BundledTheme } from 'shiki/themes'

export type ShikiThemeType = 'light' | 'dark'

export interface CodeBlockThemeInfo {
  id: BundledTheme
  displayName: string
  type: ShikiThemeType
}

/** 全部 Shiki 内置主题元数据，按 displayName 字母序排序 */
export const AVAILABLE_CODE_BLOCK_THEMES: readonly CodeBlockThemeInfo[] = bundledThemesInfo
  .map(t => ({ id: t.id as BundledTheme, displayName: t.displayName, type: t.type as ShikiThemeType }))
  .sort((a, b) => a.displayName.localeCompare(b.displayName))

export const DEFAULT_CODE_BLOCK_THEME_LIGHT = 'github-light-default' as const
export const DEFAULT_CODE_BLOCK_THEME_DARK = 'github-dark-default' as const

const knownIds = new Set<string>(AVAILABLE_CODE_BLOCK_THEMES.map(t => t.id))

/** 校验 Shiki theme id 是否存在；不存在则回退到对应默认值 */
export function normalizeCodeBlockTheme(id: string, fallback: BundledTheme): BundledTheme {
  return knownIds.has(id) ? (id as BundledTheme) : fallback
}

/** 按 type 过滤（light/dark） */
export function filterThemesByType(type: ShikiThemeType): readonly CodeBlockThemeInfo[] {
  return AVAILABLE_CODE_BLOCK_THEMES.filter(t => t.type === type)
}
