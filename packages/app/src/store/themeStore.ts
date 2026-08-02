/**
 * 主题状态管理 Store
 *
 * 管理：
 * - 主题风格选择（内置预设）
 * - 日夜模式（system / light / dark）
 * - 自定义 CSS 覆盖（可用于覆盖字体等）
 * - CSS 变量注入
 */

import { getThemePreset, themeColorsToCSSVars, builtinThemes, DEFAULT_THEME_ID } from '../themes'
import type { ThemePreset, ThemeColors } from '../themes'
import {
  DEFAULT_CODE_BLOCK_THEME_DARK,
  DEFAULT_CODE_BLOCK_THEME_LIGHT,
  normalizeCodeBlockTheme,
} from '../lib/codeBlockThemes'

// ============================================
// Color Conversion Utility
// ============================================

/**
 * 将浏览器 getComputedStyle 返回的任意格式颜色字符串转为 #RRGGBB 十六进制
 *
 * 现代 Chromium WebView 可能返回多种格式：
 * - rgb(29, 36, 50)   — 逗号分隔
 * - rgb(29 36 50)     — 空格分隔 (CSS Color Level 4)
 * - color(srgb 0.11 0.14 0.20) — sRGB 函数
 * - oklch(...)        — OKLab 色彩空间
 *
 * 利用 Canvas 2D 做万能转换，让浏览器自己解析任何合法 CSS 颜色
 */
function computedColorToHex(cssColor: string): string | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = cssColor
    // ctx.fillStyle 会被浏览器标准化为 #rrggbb 或 rgba(...) 格式
    const normalized = ctx.fillStyle
    if (normalized.startsWith('#')) return normalized
    // 如果返回 rgba/rgb 格式，提取数值转 hex
    const match = normalized.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    if (match) {
      const r = parseInt(match[1], 10)
      const g = parseInt(match[2], 10)
      const b = parseInt(match[3], 10)
      return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
    }
    return null
  } catch {
    return null
  }
}

// ============================================
// Types
// ============================================

export type ColorMode = 'system' | 'light' | 'dark'

export interface CustomCSSSnippet {
  id: string
  name: string
  css: string
  createdAt: number
  updatedAt: number
}

/** step-finish 信息栏各项显示开关 */
export interface StepFinishDisplay {
  /** 仅在用户回合末尾的最新 step 显示完成信息；中间 assistant / step 不显示 */
  latestOnly: boolean
  tokens: boolean
  cache: boolean
  cost: boolean
  duration: boolean
  turnDuration: boolean
  agent: boolean
  model: boolean
  completedAt: boolean
}

export type CompletedAtFormat = 'time' | 'dateTime'

export type ReasoningDisplayMode = 'capsule' | 'italic' | 'markdown'

export type ExternalFileDropMode = 'upload-first' | 'mention'

/**
 * 字号偏移范围：-2 ~ +4（相对于基准值的 px 偏移）
 * 0 = 基准值（index.css 中定义的默认值）
 */
export const FONT_SCALE_MIN = -2
export const FONT_SCALE_MAX = 4

function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, n)))
}

/** Diff 行标记风格：markers = 传统 +/- 符号, changeBars = 行号左侧彩色竖条 */
export type DiffStyle = 'markers' | 'changeBars'

const DEFAULT_STEP_FINISH_DISPLAY: StepFinishDisplay = {
  latestOnly: true,
  tokens: true,
  cache: true,
  cost: true,
  duration: true,
  turnDuration: true,
  agent: false,
  model: false,
  completedAt: false,
}

const DEFAULT_COMPLETED_AT_FORMAT: CompletedAtFormat = 'time'

const DEFAULT_REASONING_DISPLAY_MODE: ReasoningDisplayMode = 'markdown'
const DEFAULT_RENDER_USER_MARKDOWN = false
const DEFAULT_DIFF_STYLE: DiffStyle = 'markers'
const DEFAULT_DESCRIPTIVE_TOOL_STEPS = true
const DEFAULT_INLINE_TOOL_REQUESTS = true
const DEFAULT_CODE_WORD_WRAP = false
const DEFAULT_UI_FONT_SCALE = 0
const DEFAULT_CODE_FONT_SCALE = 0

/** 工具输出渲染风格：classic = 经典（input+output 分离），compact = 精简（只展示 output，header 更矮） */
export type ToolCardStyle = 'classic' | 'compact'
const DEFAULT_TOOL_CARD_STYLE: ToolCardStyle = 'compact'
const DEFAULT_IMMERSIVE_MODE = true
const DEFAULT_COMPACT_INLINE_PERMISSION = true
const DEFAULT_GLASS_EFFECT = true
const DEFAULT_QUEUE_FOLLOWUP_MESSAGES = false
const DEFAULT_EXTERNAL_FILE_DROP_MODE: ExternalFileDropMode = 'upload-first'
const DEFAULT_OUTLINE_CURRENT_HIGHLIGHT = true
/** 连续助手消息时，仅在回合末尾显示分叉/复制按钮 */
const DEFAULT_ACTIONS_ON_LATEST_ASSISTANT_ONLY = true
/** 桌面端是否启用输入框上滚收起（移动端始终可用） */
const DEFAULT_DESKTOP_COLLAPSED_INPUT_DOCK = true
/** 过程折叠：按用户消息把中间过程收成计时折叠块 */
const DEFAULT_PROCESS_COLLAPSE_ENABLED = false

export interface ThemeState {
  /** 当前选中的主题风格 ID */
  presetId: string
  /** 日夜模式 */
  colorMode: ColorMode
  /** 用户自定义 CSS（覆盖 CSS 变量） */
  customCSS: string
  /** 已保存的自定义 CSS 方案 */
  customCSSSnippets: CustomCSSSnippet[]
  /** 当前选中的已保存方案 ID；仅用于切换/保存，不直接决定渲染 */
  activeCustomCSSSnippetId: string | null
  /** 是否自动折叠长用户消息 */
  collapseUserMessages: boolean
  /** 是否将用户消息渲染为 Markdown */
  renderUserMarkdown: boolean
  /** step-finish 信息栏显示开关 */
  stepFinishDisplay: StepFinishDisplay
  /** 完成时刻显示格式 */
  completedAtFormat: CompletedAtFormat
  /** 思考内容展示样式 */
  reasoningDisplayMode: ReasoningDisplayMode
  /** 宽模式 */
  wideMode: boolean
  /** Diff 行标记风格 */
  diffStyle: DiffStyle
  /** 是否启用带工具描述的 steps 摘要 */
  descriptiveToolSteps: boolean
  /** 是否在工具下方内嵌权限/提问请求 */
  inlineToolRequests: boolean
  /** 代码块/diff 自动换行 */
  codeWordWrap: boolean
  /** UI 字号偏移 (px)，0 = 基准 */
  uiFontScale: number
  /** 代码 / diff / 终端字号偏移 (px)，0 = 基准 */
  codeFontScale: number
  /** 工具输出渲染风格 */
  toolCardStyle: ToolCardStyle
  /** 沉浸模式 */
  immersiveMode: boolean
  /** 内嵌权限精简模式：ToolBody 有内容时只显示操作按钮 */
  compactInlinePermission: boolean
  /** 毛玻璃效果开关（backdrop-filter blur） */
  glassEffect: boolean
  /** 忙碌时后续消息是否进入队列 */
  queueFollowupMessages: boolean
  /** 终端标签是否改为手动命名模式 */
  manualTerminalTitles: boolean
  /** 外部文件拖入输入框时的处理方式 */
  externalFileDropMode: ExternalFileDropMode
  /** 是否在对话历史导航中高亮当前对话位置 */
  outlineCurrentHighlight: boolean
  /** 连续助手消息时，仅在回合末尾显示分叉/复制按钮 */
  actionsOnLatestAssistantOnly: boolean
  /** 桌面端是否启用输入框上滚收起为胶囊 */
  desktopCollapsedInputDock: boolean
  /** 过程折叠：用户发送后显示 Working 计时，结束后收成折叠块，最终回答留在外面 */
  processCollapseEnabled: boolean
  /** 代码块语法高亮主题（亮色模式），Shiki theme id */
  codeBlockThemeLight: string
  /** 代码块语法高亮主题（暗色模式），Shiki theme id */
  codeBlockThemeDark: string
}

export type ThemeBackup = ThemeState

// ============================================
// Storage Keys
// ============================================

// 隐私模式 / 禁用存储下 localStorage 访问会抛 SecurityError，
// 统一静默兜底避免整个 store 初始化崩溃。
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 配额不足或存储不可用，忽略
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // 存储不可用，忽略
  }
}

const STORAGE_KEY_PRESET = 'piui-theme-preset'
const STORAGE_KEY_COLOR_MODE = 'piui-theme-mode'
const STORAGE_KEY_CUSTOM_CSS = 'piui-theme-custom-css'
const STORAGE_KEY_CUSTOM_CSS_SNIPPETS = 'piui-theme-custom-css-snippets'
const STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID = 'piui-theme-active-custom-css-snippet-id'
const STORAGE_KEY_COLLAPSE_USER_MESSAGES = 'piui-collapse-user-messages'
const STORAGE_KEY_RENDER_USER_MARKDOWN = 'piui-render-user-markdown'
const STORAGE_KEY_STEP_FINISH_DISPLAY = 'piui-step-finish-display'
const STORAGE_KEY_COMPLETED_AT_FORMAT = 'piui-completed-at-format'
const STORAGE_KEY_REASONING_DISPLAY_MODE = 'piui-reasoning-display-mode'
const STORAGE_KEY_WIDE_MODE = 'piui-chat-wide-mode'
const STORAGE_KEY_DIFF_STYLE = 'piui-diff-style'
const STORAGE_KEY_DESCRIPTIVE_TOOL_STEPS = 'piui-descriptive-tool-steps'
const STORAGE_KEY_INLINE_TOOL_REQUESTS = 'piui-inline-tool-requests'
const STORAGE_KEY_CODE_WORD_WRAP = 'piui-code-word-wrap'
const STORAGE_KEY_FONT_SCALE = 'piui-font-scale'
const STORAGE_KEY_CODE_FONT_SCALE = 'piui-code-font-scale'
const STORAGE_KEY_TOOL_CARD_STYLE = 'piui-tool-card-style'
const STORAGE_KEY_IMMERSIVE_MODE = 'piui-immersive-mode'
const STORAGE_KEY_COMPACT_INLINE_PERMISSION = 'piui-compact-inline-permission'
const STORAGE_KEY_GLASS_EFFECT = 'piui-glass-effect'
const STORAGE_KEY_QUEUE_FOLLOWUP_MESSAGES = 'piui-queue-followup-messages'
const STORAGE_KEY_EXTERNAL_FILE_DROP_MODE = 'piui-external-file-drop-mode'
const STORAGE_KEY_OUTLINE_CURRENT_HIGHLIGHT = 'piui-outline-current-highlight'
const STORAGE_KEY_ACTIONS_ON_LATEST_ASSISTANT_ONLY = 'piui-actions-on-latest-assistant-only'
const STORAGE_KEY_DESKTOP_COLLAPSED_INPUT_DOCK = 'piui-desktop-collapsed-input-dock'
const STORAGE_KEY_MANUAL_TERMINAL_TITLES = 'piui-manual-terminal-titles'
const STORAGE_KEY_PROCESS_COLLAPSE_ENABLED = 'piui-process-collapse-enabled'
const STORAGE_KEY_CODE_BLOCK_THEME_LIGHT = 'piui-code-block-theme-light'
const STORAGE_KEY_CODE_BLOCK_THEME_DARK = 'piui-code-block-theme-dark'

// ============================================
// DOM Style Element IDs
// ============================================

const STYLE_ID_THEME = 'piui-theme-vars'
const STYLE_ID_FONT_SCALE = 'piui-font-scale'
const STYLE_ID_CUSTOM = 'piui-custom-css'

function parseCustomCSSSnippets(raw: string | null): CustomCSSSnippet[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (item): item is CustomCSSSnippet =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.css === 'string' &&
        typeof item.createdAt === 'number' &&
        typeof item.updatedAt === 'number',
    )
  } catch {
    return []
  }
}

// ============================================
// Store Implementation
// ============================================

class ThemeStore {
  private state: ThemeState
  private listeners = new Set<() => void>()

  constructor() {
    const savedPreset = storageGet(STORAGE_KEY_PRESET) || DEFAULT_THEME_ID
    const normalizedPreset = getThemePreset(savedPreset) ? savedPreset : DEFAULT_THEME_ID
    const savedMode = (storageGet(STORAGE_KEY_COLOR_MODE) as ColorMode) || 'system'
    const savedCSS = storageGet(STORAGE_KEY_CUSTOM_CSS) || ''
    const customCSSSnippets = parseCustomCSSSnippets(storageGet(STORAGE_KEY_CUSTOM_CSS_SNIPPETS))
    const savedActiveCustomCSSSnippetId = storageGet(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID)
    const activeCustomCSSSnippetId = customCSSSnippets.some(item => item.id === savedActiveCustomCSSSnippetId)
      ? savedActiveCustomCSSSnippetId
      : null
    const savedCollapse = storageGet(STORAGE_KEY_COLLAPSE_USER_MESSAGES)
    const collapseUserMessages = savedCollapse === null ? true : savedCollapse === 'true'
    const savedRenderUserMarkdown = storageGet(STORAGE_KEY_RENDER_USER_MARKDOWN)
    const renderUserMarkdown =
      savedRenderUserMarkdown === null ? DEFAULT_RENDER_USER_MARKDOWN : savedRenderUserMarkdown === 'true'
    const savedReasoningDisplay = storageGet(STORAGE_KEY_REASONING_DISPLAY_MODE)
    const reasoningDisplayMode: ReasoningDisplayMode =
      savedReasoningDisplay === 'italic' || savedReasoningDisplay === 'markdown'
        ? savedReasoningDisplay
        : DEFAULT_REASONING_DISPLAY_MODE

    let stepFinishDisplay = DEFAULT_STEP_FINISH_DISPLAY
    try {
      const saved = storageGet(STORAGE_KEY_STEP_FINISH_DISPLAY)
      if (saved) stepFinishDisplay = { ...DEFAULT_STEP_FINISH_DISPLAY, ...JSON.parse(saved) }
    } catch {
      /* ignore */
    }

    const savedCompletedAtFormat = storageGet(STORAGE_KEY_COMPLETED_AT_FORMAT)
    const completedAtFormat: CompletedAtFormat =
      savedCompletedAtFormat === 'dateTime' ? 'dateTime' : DEFAULT_COMPLETED_AT_FORMAT

    const savedWideMode = storageGet(STORAGE_KEY_WIDE_MODE) === 'true'
    const savedDiffStyle = storageGet(STORAGE_KEY_DIFF_STYLE) as DiffStyle | null
    const diffStyle: DiffStyle = savedDiffStyle === 'changeBars' ? 'changeBars' : DEFAULT_DIFF_STYLE

    const savedDescriptiveToolSteps = storageGet(STORAGE_KEY_DESCRIPTIVE_TOOL_STEPS)
    const descriptiveToolSteps =
      savedDescriptiveToolSteps === null ? DEFAULT_DESCRIPTIVE_TOOL_STEPS : savedDescriptiveToolSteps === 'true'

    const savedInlineToolRequests = storageGet(STORAGE_KEY_INLINE_TOOL_REQUESTS)
    const inlineToolRequests =
      savedInlineToolRequests === null ? DEFAULT_INLINE_TOOL_REQUESTS : savedInlineToolRequests === 'true'

    const savedCodeWordWrap = storageGet(STORAGE_KEY_CODE_WORD_WRAP)
    const codeWordWrap = savedCodeWordWrap === 'true' ? true : DEFAULT_CODE_WORD_WRAP

    const savedFontScale = storageGet(STORAGE_KEY_FONT_SCALE)
    const uiFontScale = savedFontScale !== null ? clampFontScale(Number(savedFontScale)) : DEFAULT_UI_FONT_SCALE

    const savedCodeFontScale = storageGet(STORAGE_KEY_CODE_FONT_SCALE)
    const codeFontScale =
      savedCodeFontScale !== null ? clampFontScale(Number(savedCodeFontScale)) : DEFAULT_CODE_FONT_SCALE

    const savedToolCardStyle = storageGet(STORAGE_KEY_TOOL_CARD_STYLE) as ToolCardStyle | null
    const toolCardStyle: ToolCardStyle =
      savedToolCardStyle === 'classic' || savedToolCardStyle === 'compact'
        ? savedToolCardStyle
        : DEFAULT_TOOL_CARD_STYLE

    const savedImmersiveMode = storageGet(STORAGE_KEY_IMMERSIVE_MODE)
    const immersiveMode = savedImmersiveMode === null ? DEFAULT_IMMERSIVE_MODE : savedImmersiveMode === 'true'

    const savedCompactInlinePermission = storageGet(STORAGE_KEY_COMPACT_INLINE_PERMISSION)
    const compactInlinePermission =
      savedCompactInlinePermission === null
        ? DEFAULT_COMPACT_INLINE_PERMISSION
        : savedCompactInlinePermission === 'true'

    const savedGlassEffect = storageGet(STORAGE_KEY_GLASS_EFFECT)
    const glassEffect = savedGlassEffect === null ? DEFAULT_GLASS_EFFECT : savedGlassEffect === 'true'

    const savedQueueFollowupMessages = storageGet(STORAGE_KEY_QUEUE_FOLLOWUP_MESSAGES)
    const queueFollowupMessages =
      savedQueueFollowupMessages === null ? DEFAULT_QUEUE_FOLLOWUP_MESSAGES : savedQueueFollowupMessages === 'true'


    const savedExternalFileDropMode = storageGet(STORAGE_KEY_EXTERNAL_FILE_DROP_MODE)
    const externalFileDropMode: ExternalFileDropMode =
      savedExternalFileDropMode === 'mention' ? 'mention' : DEFAULT_EXTERNAL_FILE_DROP_MODE

    const savedOutlineCurrentHighlight = storageGet(STORAGE_KEY_OUTLINE_CURRENT_HIGHLIGHT)
    const outlineCurrentHighlight =
      savedOutlineCurrentHighlight === null
        ? DEFAULT_OUTLINE_CURRENT_HIGHLIGHT
        : savedOutlineCurrentHighlight === 'true'

    const savedActionsOnLatestAssistantOnly = storageGet(STORAGE_KEY_ACTIONS_ON_LATEST_ASSISTANT_ONLY)
    const actionsOnLatestAssistantOnly =
      savedActionsOnLatestAssistantOnly === null
        ? DEFAULT_ACTIONS_ON_LATEST_ASSISTANT_ONLY
        : savedActionsOnLatestAssistantOnly === 'true'

    const savedDesktopCollapsedInputDock = storageGet(STORAGE_KEY_DESKTOP_COLLAPSED_INPUT_DOCK)
    const desktopCollapsedInputDock =
      savedDesktopCollapsedInputDock === null
        ? DEFAULT_DESKTOP_COLLAPSED_INPUT_DOCK
        : savedDesktopCollapsedInputDock === 'true'

    const savedProcessCollapseEnabled = storageGet(STORAGE_KEY_PROCESS_COLLAPSE_ENABLED)
    const processCollapseEnabled =
      savedProcessCollapseEnabled === null
        ? DEFAULT_PROCESS_COLLAPSE_ENABLED
        : savedProcessCollapseEnabled === 'true'

    const savedManualTerminalTitles = storageGet(STORAGE_KEY_MANUAL_TERMINAL_TITLES)
    const manualTerminalTitles = savedManualTerminalTitles === null ? false : savedManualTerminalTitles === 'true'

    const codeBlockThemeLight = normalizeCodeBlockTheme(
      storageGet(STORAGE_KEY_CODE_BLOCK_THEME_LIGHT) || DEFAULT_CODE_BLOCK_THEME_LIGHT,
      DEFAULT_CODE_BLOCK_THEME_LIGHT,
    )
    const codeBlockThemeDark = normalizeCodeBlockTheme(
      storageGet(STORAGE_KEY_CODE_BLOCK_THEME_DARK) || DEFAULT_CODE_BLOCK_THEME_DARK,
      DEFAULT_CODE_BLOCK_THEME_DARK,
    )

    this.state = {
      presetId: normalizedPreset,
      colorMode: savedMode,
      customCSS: savedCSS,
      customCSSSnippets,
      activeCustomCSSSnippetId,
      collapseUserMessages,
      renderUserMarkdown,
      stepFinishDisplay,
      completedAtFormat,
      reasoningDisplayMode,
      wideMode: savedWideMode,
      diffStyle,
      descriptiveToolSteps,
      inlineToolRequests,
      codeWordWrap,
      uiFontScale,
      codeFontScale,
      toolCardStyle,
      immersiveMode,
      compactInlinePermission,
      glassEffect,
      queueFollowupMessages,
      externalFileDropMode,
      outlineCurrentHighlight,
      actionsOnLatestAssistantOnly,
      desktopCollapsedInputDock,
      processCollapseEnabled,
      manualTerminalTitles,
      codeBlockThemeLight,
      codeBlockThemeDark,
    }
  }

  // ---- Getters ----

  getState(): ThemeState {
    return this.state
  }

  get presetId() {
    return this.state.presetId
  }
  get colorMode() {
    return this.state.colorMode
  }
  get customCSS() {
    return this.state.customCSS
  }
  get customCSSSnippets() {
    return this.state.customCSSSnippets
  }
  get activeCustomCSSSnippetId() {
    return this.state.activeCustomCSSSnippetId
  }
  get collapseUserMessages() {
    return this.state.collapseUserMessages
  }
  get renderUserMarkdown() {
    return this.state.renderUserMarkdown
  }
  get stepFinishDisplay() {
    return this.state.stepFinishDisplay
  }
  get completedAtFormat() {
    return this.state.completedAtFormat
  }
  get reasoningDisplayMode() {
    return this.state.reasoningDisplayMode
  }
  get wideMode() {
    return this.state.wideMode
  }
  get diffStyle() {
    return this.state.diffStyle
  }
  get descriptiveToolSteps() {
    return this.state.descriptiveToolSteps
  }
  get inlineToolRequests() {
    return this.state.inlineToolRequests
  }
  get codeWordWrap() {
    return this.state.codeWordWrap
  }
  get uiFontScale() {
    return this.state.uiFontScale
  }
  get codeFontScale() {
    return this.state.codeFontScale
  }
  get toolCardStyle() {
    return this.state.toolCardStyle
  }
  get immersiveMode() {
    return this.state.immersiveMode
  }
  get compactInlinePermission() {
    return this.state.compactInlinePermission
  }
  get glassEffect() {
    return this.state.glassEffect
  }
  get queueFollowupMessages() {
    return this.state.queueFollowupMessages
  }
  get manualTerminalTitles() {
    return this.state.manualTerminalTitles
  }
  get externalFileDropMode() {
    return this.state.externalFileDropMode
  }
  get outlineCurrentHighlight() {
    return this.state.outlineCurrentHighlight
  }

  get actionsOnLatestAssistantOnly() {
    return this.state.actionsOnLatestAssistantOnly
  }

  get desktopCollapsedInputDock() {
    return this.state.desktopCollapsedInputDock
  }

  get processCollapseEnabled() {
    return this.state.processCollapseEnabled
  }

  get codeBlockThemeLight() {
    return this.state.codeBlockThemeLight
  }

  get codeBlockThemeDark() {
    return this.state.codeBlockThemeDark
  }

  /** 获取当前主题预设（内置主题返回对象，自定义返回 undefined） */
  getPreset(): ThemePreset | undefined {
    return getThemePreset(this.state.presetId)
  }

  /** 获取所有可用主题列表 */
  getAvailablePresets(): { id: string; name: string; description: string }[] {
    return builtinThemes.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
    }))
  }

  /** 解析实际生效的暗/亮模式 */
  getResolvedMode(): 'light' | 'dark' {
    if (this.state.colorMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return this.state.colorMode
  }

  get isDark(): boolean {
    return this.getResolvedMode() === 'dark'
  }

  // ---- Mutations ----

  setPreset(id: string) {
    if (this.state.presetId === id) return
    this.state = { ...this.state, presetId: id }
    storageSet(STORAGE_KEY_PRESET, id)
    this.applyTheme()
    this.emit()
  }

  setColorMode(mode: ColorMode) {
    if (this.state.colorMode === mode) return
    this.state = { ...this.state, colorMode: mode }
    storageSet(STORAGE_KEY_COLOR_MODE, mode)
    this.applyTheme()
    this.emit()
  }

  setCustomCSS(css: string) {
    this.state = { ...this.state, customCSS: css }
    storageSet(STORAGE_KEY_CUSTOM_CSS, css)
    this.applyCustomCSS()
    this.emit()
  }

  saveCustomCSSSnippet(name: string, css: string): CustomCSSSnippet {
    const now = Date.now()
    const snippet: CustomCSSSnippet = {
      id: `css-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      css,
      createdAt: now,
      updatedAt: now,
    }

    const customCSSSnippets = [...this.state.customCSSSnippets, snippet]
    this.state = { ...this.state, customCSSSnippets, activeCustomCSSSnippetId: snippet.id }
    this.persistCustomCSSSnippets(customCSSSnippets)
    storageSet(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID, snippet.id)
    this.emit()
    return snippet
  }

  updateCustomCSSSnippet(id: string, updates: Partial<Pick<CustomCSSSnippet, 'name' | 'css'>>) {
    const customCSSSnippets = this.state.customCSSSnippets.map(item =>
      item.id === id ? { ...item, ...updates, updatedAt: Date.now() } : item,
    )

    this.state = { ...this.state, customCSSSnippets }
    this.persistCustomCSSSnippets(customCSSSnippets)
    this.emit()
  }

  deleteCustomCSSSnippet(id: string) {
    const customCSSSnippets = this.state.customCSSSnippets.filter(item => item.id !== id)
    const activeCustomCSSSnippetId =
      this.state.activeCustomCSSSnippetId === id ? null : this.state.activeCustomCSSSnippetId

    this.state = { ...this.state, customCSSSnippets, activeCustomCSSSnippetId }
    this.persistCustomCSSSnippets(customCSSSnippets)

    if (activeCustomCSSSnippetId) {
      storageSet(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID, activeCustomCSSSnippetId)
    } else {
      storageRemove(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID)
    }

    this.emit()
  }

  applyCustomCSSSnippet(id: string) {
    const snippet = this.state.customCSSSnippets.find(item => item.id === id)
    if (!snippet) return

    this.state = {
      ...this.state,
      customCSS: snippet.css,
      activeCustomCSSSnippetId: id,
    }

    storageSet(STORAGE_KEY_CUSTOM_CSS, snippet.css)
    storageSet(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID, id)
    this.applyCustomCSS()
    this.emit()
  }

  clearActiveCustomCSSSnippet() {
    if (this.state.activeCustomCSSSnippetId === null) return
    this.state = { ...this.state, activeCustomCSSSnippetId: null }
    storageRemove(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID)
    this.emit()
  }

  setCollapseUserMessages(enabled: boolean) {
    if (this.state.collapseUserMessages === enabled) return
    this.state = { ...this.state, collapseUserMessages: enabled }
    storageSet(STORAGE_KEY_COLLAPSE_USER_MESSAGES, String(enabled))
    this.emit()
  }

  setRenderUserMarkdown(enabled: boolean) {
    if (this.state.renderUserMarkdown === enabled) return
    this.state = { ...this.state, renderUserMarkdown: enabled }
    storageSet(STORAGE_KEY_RENDER_USER_MARKDOWN, String(enabled))
    this.emit()
  }

  setStepFinishDisplay(display: Partial<StepFinishDisplay>) {
    const next = { ...this.state.stepFinishDisplay, ...display }
    this.state = { ...this.state, stepFinishDisplay: next }
    storageSet(STORAGE_KEY_STEP_FINISH_DISPLAY, JSON.stringify(next))
    this.emit()
  }

  setCompletedAtFormat(format: CompletedAtFormat) {
    if (this.state.completedAtFormat === format) return
    this.state = { ...this.state, completedAtFormat: format }
    storageSet(STORAGE_KEY_COMPLETED_AT_FORMAT, format)
    this.emit()
  }

  setReasoningDisplayMode(mode: ReasoningDisplayMode) {
    if (this.state.reasoningDisplayMode === mode) return
    this.state = { ...this.state, reasoningDisplayMode: mode }
    storageSet(STORAGE_KEY_REASONING_DISPLAY_MODE, mode)
    this.emit()
  }

  setWideMode(enabled: boolean) {
    if (this.state.wideMode === enabled) return
    this.state = { ...this.state, wideMode: enabled }
    storageSet(STORAGE_KEY_WIDE_MODE, String(enabled))
    this.emit()
  }

  toggleWideMode() {
    this.setWideMode(!this.state.wideMode)
  }

  setDiffStyle(style: DiffStyle) {
    if (this.state.diffStyle === style) return
    this.state = { ...this.state, diffStyle: style }
    storageSet(STORAGE_KEY_DIFF_STYLE, style)
    this.emit()
  }

  setDescriptiveToolSteps(enabled: boolean) {
    if (this.state.descriptiveToolSteps === enabled) return
    this.state = { ...this.state, descriptiveToolSteps: enabled }
    storageSet(STORAGE_KEY_DESCRIPTIVE_TOOL_STEPS, String(enabled))
    this.emit()
  }

  setInlineToolRequests(enabled: boolean) {
    if (this.state.inlineToolRequests === enabled) return
    this.state = { ...this.state, inlineToolRequests: enabled }
    storageSet(STORAGE_KEY_INLINE_TOOL_REQUESTS, String(enabled))
    this.emit()
  }

  setCodeWordWrap(enabled: boolean) {
    if (this.state.codeWordWrap === enabled) return
    this.state = { ...this.state, codeWordWrap: enabled }
    storageSet(STORAGE_KEY_CODE_WORD_WRAP, String(enabled))
    this.emit()
  }

  setManualTerminalTitles(enabled: boolean) {
    if (this.state.manualTerminalTitles === enabled) return
    this.state = { ...this.state, manualTerminalTitles: enabled }
    storageSet(STORAGE_KEY_MANUAL_TERMINAL_TITLES, String(enabled))
    this.emit()
  }

  setUIFontScale(scale: number) {
    const clamped = clampFontScale(scale)
    if (this.state.uiFontScale === clamped) return
    this.state = { ...this.state, uiFontScale: clamped }
    storageSet(STORAGE_KEY_FONT_SCALE, String(clamped))
    this.applyFontScale()
    this.emit()
  }

  setCodeFontScale(scale: number) {
    const clamped = clampFontScale(scale)
    if (this.state.codeFontScale === clamped) return
    this.state = { ...this.state, codeFontScale: clamped }
    storageSet(STORAGE_KEY_CODE_FONT_SCALE, String(clamped))
    this.applyFontScale()
    this.emit()
  }

  setToolCardStyle(style: ToolCardStyle) {
    if (this.state.toolCardStyle === style) return
    this.state = { ...this.state, toolCardStyle: style }
    storageSet(STORAGE_KEY_TOOL_CARD_STYLE, style)
    this.emit()
  }

  setImmersiveMode(enabled: boolean) {
    if (this.state.immersiveMode === enabled) return
    this.state = {
      ...this.state,
      immersiveMode: enabled,
      // 联动四个子功能
      inlineToolRequests: enabled,
      descriptiveToolSteps: enabled,
      toolCardStyle: enabled ? 'compact' : 'classic',
      compactInlinePermission: enabled,
    }
    storageSet(STORAGE_KEY_IMMERSIVE_MODE, String(enabled))
    storageSet(STORAGE_KEY_INLINE_TOOL_REQUESTS, String(enabled))
    storageSet(STORAGE_KEY_DESCRIPTIVE_TOOL_STEPS, String(enabled))
    storageSet(STORAGE_KEY_TOOL_CARD_STYLE, enabled ? 'compact' : 'classic')
    storageSet(STORAGE_KEY_COMPACT_INLINE_PERMISSION, String(enabled))
    this.emit()
  }

  setCompactInlinePermission(enabled: boolean) {
    if (this.state.compactInlinePermission === enabled) return
    this.state = { ...this.state, compactInlinePermission: enabled }
    storageSet(STORAGE_KEY_COMPACT_INLINE_PERMISSION, String(enabled))
    this.emit()
  }

  setGlassEffect(enabled: boolean) {
    if (this.state.glassEffect === enabled) return
    this.state = { ...this.state, glassEffect: enabled }
    storageSet(STORAGE_KEY_GLASS_EFFECT, String(enabled))
    this.applyGlassClass()
    this.emit()
  }

  setQueueFollowupMessages(enabled: boolean) {
    if (this.state.queueFollowupMessages === enabled) return
    this.state = { ...this.state, queueFollowupMessages: enabled }
    storageSet(STORAGE_KEY_QUEUE_FOLLOWUP_MESSAGES, String(enabled))
    this.emit()
  }

  setExternalFileDropMode(mode: ExternalFileDropMode) {
    if (this.state.externalFileDropMode === mode) return
    this.state = { ...this.state, externalFileDropMode: mode }
    storageSet(STORAGE_KEY_EXTERNAL_FILE_DROP_MODE, mode)
    this.emit()
  }

  setOutlineCurrentHighlight(enabled: boolean) {
    if (this.state.outlineCurrentHighlight === enabled) return
    this.state = { ...this.state, outlineCurrentHighlight: enabled }
    storageSet(STORAGE_KEY_OUTLINE_CURRENT_HIGHLIGHT, String(enabled))
    this.emit()
  }

  setActionsOnLatestAssistantOnly(enabled: boolean) {
    if (this.state.actionsOnLatestAssistantOnly === enabled) return
    this.state = { ...this.state, actionsOnLatestAssistantOnly: enabled }
    storageSet(STORAGE_KEY_ACTIONS_ON_LATEST_ASSISTANT_ONLY, String(enabled))
    this.emit()
  }

  setDesktopCollapsedInputDock(enabled: boolean) {
    if (this.state.desktopCollapsedInputDock === enabled) return
    this.state = { ...this.state, desktopCollapsedInputDock: enabled }
    storageSet(STORAGE_KEY_DESKTOP_COLLAPSED_INPUT_DOCK, String(enabled))
    this.emit()
  }

  setProcessCollapseEnabled(enabled: boolean) {
    if (this.state.processCollapseEnabled === enabled) return
    this.state = { ...this.state, processCollapseEnabled: enabled }
    storageSet(STORAGE_KEY_PROCESS_COLLAPSE_ENABLED, String(enabled))
    this.emit()
  }

  setCodeBlockThemeLight(id: string) {
    const next = normalizeCodeBlockTheme(id, DEFAULT_CODE_BLOCK_THEME_LIGHT)
    if (this.state.codeBlockThemeLight === next) return
    this.state = { ...this.state, codeBlockThemeLight: next }
    storageSet(STORAGE_KEY_CODE_BLOCK_THEME_LIGHT, next)
    this.emit()
  }

  setCodeBlockThemeDark(id: string) {
    const next = normalizeCodeBlockTheme(id, DEFAULT_CODE_BLOCK_THEME_DARK)
    if (this.state.codeBlockThemeDark === next) return
    this.state = { ...this.state, codeBlockThemeDark: next }
    storageSet(STORAGE_KEY_CODE_BLOCK_THEME_DARK, next)
    this.emit()
  }

  // ---- Theme Application ----

  /** 初始化：应用当前主题到 DOM */
  init() {
    this.applyTheme()
    this.applyFontScale()
    this.applyGlassClass()

    // 监听系统主题变化
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', () => {
      if (this.state.colorMode === 'system') {
        this.applyTheme()
        this.emit()
      }
    })
  }

  /** 将主题 CSS 变量注入到 DOM */
  applyTheme() {
    const root = document.documentElement
    const resolvedMode = this.getResolvedMode()

    // 1. 设置 data-mode（驱动 CSS 中日/夜模式相关的非颜色规则，以及 Terminal、Shiki 等联动）
    if (this.state.colorMode === 'system') {
      root.removeAttribute('data-mode')
    } else {
      root.setAttribute('data-mode', this.state.colorMode)
    }

    // 2. 注入主题颜色变量
    const preset = this.getPreset()
    if (preset) {
      const colors: ThemeColors = resolvedMode === 'dark' ? preset.dark : preset.light
      this.injectThemeStyle(colors)
    }

    // 3. 应用自定义 CSS
    this.applyCustomCSS()

    // 4. 更新 meta theme-color
    requestAnimationFrame(() => {
      const bg = getComputedStyle(root).getPropertyValue('--color-bg-100').trim()
      if (!bg) return

      // 将计算后的颜色统一转为 HEX 格式，避免不同浏览器/WebView 返回
      // 不同格式（rgb, oklch, color(srgb ...)）导致 Android 原生端解析失败或色差
      const hex = computedColorToHex(bg)
      if (!hex) return

      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', hex)

      const androidBridge = (
        window as unknown as { __opencode_android?: { setSystemBars?: (mode: string, bg: string) => void } }
      ).__opencode_android
      if (androidBridge?.setSystemBars) {
        androidBridge.setSystemBars(resolvedMode, hex)
      }
    })
  }

  private injectThemeStyle(colors: ThemeColors) {
    let el = document.getElementById(STYLE_ID_THEME) as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID_THEME
      document.head.appendChild(el)
    }

    // 用高优先级选择器覆盖 :root 中的默认值
    // 使用 :root:root 提升特异性，确保覆盖 index.css 中的所有定义
    el.textContent = `:root:root {\n  ${themeColorsToCSSVars(colors)}\n}`
  }

  /**
   * 字号偏移覆盖。
   * 两个维度均为 0 时不注入覆盖，直接用 index.css :root 里的默认值。
   * 非零时通过 :root:root 高优先级覆盖 --fs-* 变量。
   *
   * 基准值（偏移 0）：
   *   UI:   xxs=11  xs=12  sm=13  md=13  base=14  lg=16
   *         heading-3=16  heading-2=18  heading-1=20
   *   Code: code=13  code-line-height=24  terminal=13  terminal-line-height=1.4
   */
  private applyFontScale() {
    const { uiFontScale: ui, codeFontScale: code } = this.state
    let el = document.getElementById(STYLE_ID_FONT_SCALE) as HTMLStyleElement | null

    if (ui === 0 && code === 0) {
      if (el) el.remove()
      return
    }

    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID_FONT_SCALE
      document.head.appendChild(el)
    }

    const vars: string[] = []

    if (ui !== 0) {
      vars.push(
        `--fs-xxs: ${11 + ui}px`,
        `--fs-xs: ${12 + ui}px`,
        `--fs-sm: ${13 + ui}px`,
        `--fs-md: ${13 + ui}px`,
        `--fs-base: ${14 + ui}px`,
        `--fs-lg: ${16 + ui}px`,
        `--fs-heading-3: ${16 + ui}px`,
        `--fs-heading-2: ${18 + ui}px`,
        `--fs-heading-1: ${20 + ui}px`,
      )
    }

    if (code !== 0) {
      const codePx = 13 + code
      // 行高 = 基准 24 + 偏移 * 2（每 1px 字号对应 2px 行高增量）
      const lineH = 24 + code * 2
      const termPx = 13 + code
      const termLH = Math.round((1.4 + code * 0.05) * 100) / 100
      vars.push(
        `--fs-code: ${codePx}px`,
        `--fs-code-line-height: ${lineH}px`,
        `--fs-terminal: ${termPx}px`,
        `--fs-terminal-line-height: ${termLH}`,
      )
    }

    el.textContent = `:root:root {\n  ${vars.join(';\n  ')};\n}`
  }

  private applyCustomCSS() {
    const css = this.state.customCSS.trim()
    let el = document.getElementById(STYLE_ID_CUSTOM) as HTMLStyleElement | null

    if (!css) {
      if (el) el.remove()
      return
    }

    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID_CUSTOM
      document.head.appendChild(el)
    }
    el.textContent = css
  }

  /** 毛玻璃开关：data-glass 属性驱动 CSS */
  private applyGlassClass() {
    const root = document.documentElement
    if (this.state.glassEffect) {
      root.setAttribute('data-glass', '')
    } else {
      root.removeAttribute('data-glass')
    }
  }

  private persistCustomCSSSnippets(customCSSSnippets: CustomCSSSnippet[]) {
    storageSet(STORAGE_KEY_CUSTOM_CSS_SNIPPETS, JSON.stringify(customCSSSnippets))
  }

  // ---- Subscription (useSyncExternalStore compatible) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ThemeState => {
    return this.state
  }

  private emit() {
    this.listeners.forEach(fn => fn())
  }
}

// Singleton
export const themeStore = new ThemeStore()

function normalizeThemeBackup(raw: unknown): ThemeBackup {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const customCSSSnippets = parseCustomCSSSnippets(
    JSON.stringify(Array.isArray(parsed?.customCSSSnippets) ? parsed.customCSSSnippets : []),
  )
  const activeCustomCSSSnippetId =
    typeof parsed?.activeCustomCSSSnippetId === 'string' &&
    customCSSSnippets.some(item => item.id === parsed.activeCustomCSSSnippetId)
      ? parsed.activeCustomCSSSnippetId
      : null

  return {
    presetId:
      typeof parsed?.presetId === 'string' && getThemePreset(parsed.presetId) ? parsed.presetId : DEFAULT_THEME_ID,
    colorMode: parsed?.colorMode === 'light' || parsed?.colorMode === 'dark' ? parsed.colorMode : 'system',
    customCSS: typeof parsed?.customCSS === 'string' ? parsed.customCSS : '',
    customCSSSnippets,
    activeCustomCSSSnippetId,
    collapseUserMessages: typeof parsed?.collapseUserMessages === 'boolean' ? parsed.collapseUserMessages : true,
    renderUserMarkdown:
      typeof parsed?.renderUserMarkdown === 'boolean' ? parsed.renderUserMarkdown : DEFAULT_RENDER_USER_MARKDOWN,
    stepFinishDisplay:
      parsed?.stepFinishDisplay && typeof parsed.stepFinishDisplay === 'object'
        ? { ...DEFAULT_STEP_FINISH_DISPLAY, ...(parsed.stepFinishDisplay as Partial<StepFinishDisplay>) }
        : DEFAULT_STEP_FINISH_DISPLAY,
    completedAtFormat: parsed?.completedAtFormat === 'dateTime' ? 'dateTime' : DEFAULT_COMPLETED_AT_FORMAT,
    reasoningDisplayMode:
      parsed?.reasoningDisplayMode === 'italic' || parsed?.reasoningDisplayMode === 'markdown'
        ? parsed.reasoningDisplayMode
        : DEFAULT_REASONING_DISPLAY_MODE,
    wideMode: parsed?.wideMode === true,
    diffStyle: parsed?.diffStyle === 'changeBars' ? 'changeBars' : DEFAULT_DIFF_STYLE,
    descriptiveToolSteps:
      typeof parsed?.descriptiveToolSteps === 'boolean' ? parsed.descriptiveToolSteps : DEFAULT_DESCRIPTIVE_TOOL_STEPS,
    inlineToolRequests:
      typeof parsed?.inlineToolRequests === 'boolean' ? parsed.inlineToolRequests : DEFAULT_INLINE_TOOL_REQUESTS,
    codeWordWrap: typeof parsed?.codeWordWrap === 'boolean' ? parsed.codeWordWrap : DEFAULT_CODE_WORD_WRAP,
    uiFontScale: clampFontScale(typeof parsed?.uiFontScale === 'number' ? parsed.uiFontScale : DEFAULT_UI_FONT_SCALE),
    codeFontScale: clampFontScale(
      typeof parsed?.codeFontScale === 'number' ? parsed.codeFontScale : DEFAULT_CODE_FONT_SCALE,
    ),
    toolCardStyle:
      parsed?.toolCardStyle === 'classic' || parsed?.toolCardStyle === 'compact'
        ? parsed.toolCardStyle
        : DEFAULT_TOOL_CARD_STYLE,
    immersiveMode: typeof parsed?.immersiveMode === 'boolean' ? parsed.immersiveMode : DEFAULT_IMMERSIVE_MODE,
    compactInlinePermission:
      typeof parsed?.compactInlinePermission === 'boolean'
        ? parsed.compactInlinePermission
        : DEFAULT_COMPACT_INLINE_PERMISSION,
    glassEffect: typeof parsed?.glassEffect === 'boolean' ? parsed.glassEffect : DEFAULT_GLASS_EFFECT,
    queueFollowupMessages:
      typeof parsed?.queueFollowupMessages === 'boolean'
        ? parsed.queueFollowupMessages
        : DEFAULT_QUEUE_FOLLOWUP_MESSAGES,
    manualTerminalTitles: typeof parsed?.manualTerminalTitles === 'boolean' ? parsed.manualTerminalTitles : false,
    externalFileDropMode: parsed?.externalFileDropMode === 'mention' ? 'mention' : DEFAULT_EXTERNAL_FILE_DROP_MODE,
    outlineCurrentHighlight:
      typeof parsed?.outlineCurrentHighlight === 'boolean'
        ? parsed.outlineCurrentHighlight
        : DEFAULT_OUTLINE_CURRENT_HIGHLIGHT,
    actionsOnLatestAssistantOnly:
      typeof parsed?.actionsOnLatestAssistantOnly === 'boolean'
        ? parsed.actionsOnLatestAssistantOnly
        : DEFAULT_ACTIONS_ON_LATEST_ASSISTANT_ONLY,
    desktopCollapsedInputDock:
      typeof parsed?.desktopCollapsedInputDock === 'boolean'
        ? parsed.desktopCollapsedInputDock
        : DEFAULT_DESKTOP_COLLAPSED_INPUT_DOCK,
    processCollapseEnabled:
      typeof parsed?.processCollapseEnabled === 'boolean'
        ? parsed.processCollapseEnabled
        : DEFAULT_PROCESS_COLLAPSE_ENABLED,
    codeBlockThemeLight: normalizeCodeBlockTheme(
      typeof parsed?.codeBlockThemeLight === 'string' ? parsed.codeBlockThemeLight : DEFAULT_CODE_BLOCK_THEME_LIGHT,
      DEFAULT_CODE_BLOCK_THEME_LIGHT,
    ),
    codeBlockThemeDark: normalizeCodeBlockTheme(
      typeof parsed?.codeBlockThemeDark === 'string' ? parsed.codeBlockThemeDark : DEFAULT_CODE_BLOCK_THEME_DARK,
      DEFAULT_CODE_BLOCK_THEME_DARK,
    ),
  }
}

export function exportThemeBackup(): ThemeBackup {
  const state = themeStore.getState()
  return {
    ...state,
    customCSSSnippets: state.customCSSSnippets.map(item => ({ ...item })),
    stepFinishDisplay: { ...state.stepFinishDisplay },
  }
}

export function importThemeBackup(raw: unknown): void {
  const backup = normalizeThemeBackup(raw)
  storageSet(STORAGE_KEY_PRESET, backup.presetId)
  storageSet(STORAGE_KEY_COLOR_MODE, backup.colorMode)
  storageSet(STORAGE_KEY_CUSTOM_CSS, backup.customCSS)
  storageSet(STORAGE_KEY_CUSTOM_CSS_SNIPPETS, JSON.stringify(backup.customCSSSnippets))
  if (backup.activeCustomCSSSnippetId) {
    storageSet(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID, backup.activeCustomCSSSnippetId)
  } else {
    storageRemove(STORAGE_KEY_ACTIVE_CUSTOM_CSS_SNIPPET_ID)
  }
  storageSet(STORAGE_KEY_COLLAPSE_USER_MESSAGES, String(backup.collapseUserMessages))
  storageSet(STORAGE_KEY_RENDER_USER_MARKDOWN, String(backup.renderUserMarkdown))
  storageSet(STORAGE_KEY_STEP_FINISH_DISPLAY, JSON.stringify(backup.stepFinishDisplay))
  storageSet(STORAGE_KEY_COMPLETED_AT_FORMAT, backup.completedAtFormat)
  storageSet(STORAGE_KEY_REASONING_DISPLAY_MODE, backup.reasoningDisplayMode)
  storageSet(STORAGE_KEY_WIDE_MODE, String(backup.wideMode))
  storageSet(STORAGE_KEY_DIFF_STYLE, backup.diffStyle)
  storageSet(STORAGE_KEY_DESCRIPTIVE_TOOL_STEPS, String(backup.descriptiveToolSteps))
  storageSet(STORAGE_KEY_INLINE_TOOL_REQUESTS, String(backup.inlineToolRequests))
  storageSet(STORAGE_KEY_CODE_WORD_WRAP, String(backup.codeWordWrap))
  storageSet(STORAGE_KEY_FONT_SCALE, String(backup.uiFontScale))
  storageSet(STORAGE_KEY_CODE_FONT_SCALE, String(backup.codeFontScale))
  storageSet(STORAGE_KEY_TOOL_CARD_STYLE, backup.toolCardStyle)
  storageSet(STORAGE_KEY_IMMERSIVE_MODE, String(backup.immersiveMode))
  storageSet(STORAGE_KEY_COMPACT_INLINE_PERMISSION, String(backup.compactInlinePermission))
  storageSet(STORAGE_KEY_GLASS_EFFECT, String(backup.glassEffect))
  storageSet(STORAGE_KEY_QUEUE_FOLLOWUP_MESSAGES, String(backup.queueFollowupMessages))
  storageSet(STORAGE_KEY_EXTERNAL_FILE_DROP_MODE, backup.externalFileDropMode)
  storageSet(STORAGE_KEY_OUTLINE_CURRENT_HIGHLIGHT, String(backup.outlineCurrentHighlight))
  storageSet(
    STORAGE_KEY_ACTIONS_ON_LATEST_ASSISTANT_ONLY,
    String(backup.actionsOnLatestAssistantOnly),
  )
  storageSet(STORAGE_KEY_DESKTOP_COLLAPSED_INPUT_DOCK, String(backup.desktopCollapsedInputDock))
  storageSet(STORAGE_KEY_PROCESS_COLLAPSE_ENABLED, String(backup.processCollapseEnabled))
  storageSet(STORAGE_KEY_CODE_BLOCK_THEME_LIGHT, backup.codeBlockThemeLight)
  storageSet(STORAGE_KEY_CODE_BLOCK_THEME_DARK, backup.codeBlockThemeDark)
}
