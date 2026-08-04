// ============================================
// LayoutStore - 全局 UI 布局状态
// ============================================

import type { TerminalInfo } from '@piui/protocol'

// 面板位置
export type PanelPosition = 'bottom' | 'right'

// 面板内容类型
export type PanelTabType = 'terminal' | 'files' | 'changes' | 'session-tree' | 'session-controls' | 'skill' | 'extensions'
type PersistedPanelTabType = Exclude<PanelTabType, 'terminal'>

// 统一的面板标签
export interface PanelTab {
  id: string
  type: PanelTabType
  position: PanelPosition
  previewFile?: PreviewFile | null
  previewFiles?: PreviewFile[]
  // Terminal 特有属性
  terminalId?: string
  title?: string
  shellTitle?: string
  shell?: string
  cwd?: string
  customTitle?: string
  buffer?: string
  scrollY?: number
  cursor?: number
  rows?: number
  cols?: number
  status?: 'connecting' | 'connected' | 'disconnected' | 'exited'
}

export interface TerminalTab {
  id: string
  title: string
  customTitle?: string
  shellTitle?: string
  status: 'connecting' | 'connected' | 'disconnected' | 'exited'
  shell?: string
  cwd?: string
  buffer?: string
  scrollY?: number
  cursor?: number
  rows?: number
  cols?: number
}

// 文件预览的文件信息
export interface PreviewFile {
  path: string
  name: string
  targetLine?: number
  targetKey?: string
  targetRanges?: Array<{ from: number; to: number }>
}

const MAX_RIGHT_PANEL_WIDTH = 1280

// 旧的 RightPanelView 类型 - 兼容
export type RightPanelView = 'files' | 'changes'

interface LayoutState {
  // 统一的面板标签系统
  panelTabs: PanelTab[]
  activeTabId: {
    bottom: string | null
    right: string | null
  }

  // 侧边栏
  sidebarExpanded: boolean
  sidebarFolderRecents: boolean
  sidebarShowChildSessions: boolean

  // 右侧栏
  rightPanelOpen: boolean
  rightPanelWidth: number

  // 底部面板
  bottomPanelOpen: boolean
  bottomPanelHeight: number

  // 屏幕常亮
  wakeLock: boolean

  terminalCopyOnSelect: boolean
  terminalRightClickPaste: boolean
}

type Subscriber = () => void

const STORAGE_KEY_WAKE_LOCK = 'piui-wake-lock'
const STORAGE_KEY_SIDEBAR = 'piui-sidebar-expanded'
const STORAGE_KEY_SIDEBAR_FOLDER_RECENTS = 'piui-sidebar-folder-recents'
const STORAGE_KEY_SIDEBAR_SHOW_CHILD_SESSIONS = 'piui-sidebar-show-child-sessions'
const STORAGE_KEY_PANEL_LAYOUT = 'piui-panel-layout'
const STORAGE_KEY_TERMINAL_LAYOUT = 'piui-terminal-layout'
const STORAGE_KEY_RIGHT_PANEL_WIDTH = 'piui-right-panel-width'
const STORAGE_KEY_BOTTOM_PANEL_HEIGHT = 'piui-bottom-panel-height'
const STORAGE_KEY_VIEWPORT_SIDEBAR_WIDTH = 'piui-sidebar-width'

// 隐私模式 / 禁用存储下 localStorage 访问会抛 SecurityError，统一静默兜底。
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

interface PersistedPanelTab {
  id: string
  type: PersistedPanelTabType
  position: PanelPosition
  title?: string
}

export interface PersistedPanelLayout {
  version: 1
  panelTabs: PersistedPanelTab[]
  activeTabId: LayoutState['activeTabId']
  rightPanelOpen: boolean
  bottomPanelOpen: boolean
}

export interface PersistedTerminalDirectoryLayout {
  order: Record<PanelPosition, string[]>
  activeTabId: LayoutState['activeTabId']
  sessions?: Record<string, PersistedTerminalSessionState>
}

export interface PersistedTerminalLayoutMap {
  version: 1
  directories: Record<string, PersistedTerminalDirectoryLayout>
}

interface PersistedTerminalSessionState {
  title?: string
  shellTitle?: string
  customTitle?: string
  buffer?: string
  scrollY?: number
  cursor?: number
  rows?: number
  cols?: number
}

const PANEL_POSITIONS: PanelPosition[] = ['bottom', 'right']
const PERSISTED_PANEL_TAB_TYPES: PersistedPanelTabType[] = ['files', 'changes', 'session-tree', 'session-controls', 'skill', 'extensions']

function isPanelPosition(value: unknown): value is PanelPosition {
  return typeof value === 'string' && PANEL_POSITIONS.includes(value as PanelPosition)
}

function isPersistedPanelTabType(value: unknown): value is PersistedPanelTabType {
  return typeof value === 'string' && PERSISTED_PANEL_TAB_TYPES.includes(value as PersistedPanelTabType)
}

function normalizePersistedPanelTab(tab: PersistedPanelTab): PanelTab {
  if (tab.type === 'files') {
    return {
      id: tab.id,
      type: 'files',
      position: tab.position,
      title: tab.title,
      previewFile: null,
      previewFiles: []
    }
  }

  return {
    id: tab.id,
    type: tab.type,
    position: tab.position,
    title: tab.title
  }
}

function sanitizePersistedPanelLayout(raw: unknown): PersistedPanelLayout | null {
  if (!raw || typeof raw !== 'object') return null

  const data = raw as Partial<PersistedPanelLayout>
  if (data.version !== 1 || !Array.isArray(data.panelTabs) || !data.activeTabId || typeof data.activeTabId !== 'object') {
    return null
  }

  const seenIds = new Set<string>()
  const panelTabs: PersistedPanelTab[] = []
  for (const item of data.panelTabs) {
    if (!item || typeof item !== 'object') continue
    const tab = item as Partial<PersistedPanelTab>
    if (typeof tab.id !== 'string' || !tab.id || seenIds.has(tab.id)) continue
    if (!isPersistedPanelTabType(tab.type) || !isPanelPosition(tab.position)) continue
    if (tab.title !== undefined && typeof tab.title !== 'string') continue
    seenIds.add(tab.id)
    panelTabs.push({
      id: tab.id,
      type: tab.type,
      position: tab.position,
      title: tab.title
    })
  }

  return {
    version: 1,
    panelTabs,
    activeTabId: {
      bottom: typeof data.activeTabId.bottom === 'string' ? data.activeTabId.bottom : null,
      right: typeof data.activeTabId.right === 'string' ? data.activeTabId.right : null
    },
    rightPanelOpen: data.rightPanelOpen === true,
    bottomPanelOpen: data.bottomPanelOpen === true
  }
}

function sanitizePersistedTerminalLayoutMap(raw: unknown): PersistedTerminalLayoutMap {
  if (!raw || typeof raw !== 'object') return { version: 1, directories: {} }

  const data = raw as Partial<PersistedTerminalLayoutMap>
  if (data.version !== 1 || !data.directories || typeof data.directories !== 'object') {
    return { version: 1, directories: {} }
  }

  const directories: Record<string, PersistedTerminalDirectoryLayout> = {}
  for (const [directory, value] of Object.entries(data.directories)) {
    if (!directory || !value || typeof value !== 'object') continue
    const entry = value as Partial<PersistedTerminalDirectoryLayout>
    const rawOrder = entry.order
    const rawActiveTabId = entry.activeTabId
    if (!rawOrder || typeof rawOrder !== 'object' || !rawActiveTabId || typeof rawActiveTabId !== 'object') continue

    const order = {
      bottom: Array.isArray(rawOrder.bottom) ? rawOrder.bottom.filter((id): id is string => typeof id === 'string' && id.length > 0) : [],
      right: Array.isArray(rawOrder.right) ? rawOrder.right.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    }

    const sessions: Record<string, PersistedTerminalSessionState> = {}
    if (entry.sessions && typeof entry.sessions === 'object') {
      for (const [id, session] of Object.entries(entry.sessions)) {
        if (!id || !session || typeof session !== 'object') continue
        const data = session as Partial<PersistedTerminalSessionState>
        sessions[id] = {
          title: typeof data.title === 'string' ? data.title : undefined,
          shellTitle: typeof data.shellTitle === 'string' ? data.shellTitle : undefined,
          customTitle: typeof data.customTitle === 'string' ? data.customTitle : undefined,
          buffer: typeof data.buffer === 'string' ? data.buffer : undefined,
          scrollY: typeof data.scrollY === 'number' ? data.scrollY : undefined,
          cursor: typeof data.cursor === 'number' ? data.cursor : undefined,
          rows: typeof data.rows === 'number' ? data.rows : undefined,
          cols: typeof data.cols === 'number' ? data.cols : undefined
        }
      }
    }

    directories[directory] = {
      order,
      activeTabId: {
        bottom: typeof rawActiveTabId.bottom === 'string' ? rawActiveTabId.bottom : null,
        right: typeof rawActiveTabId.right === 'string' ? rawActiveTabId.right : null
      },
      sessions
    }
  }

  return { version: 1, directories }
}

function buildTerminalPanelTab(tab: TerminalTab, position: PanelPosition, existing?: PanelTab): PanelTab {
  return {
    id: tab.id,
    type: 'terminal',
    position,
    terminalId: tab.id,
    title: existing?.title ?? tab.title,
    shellTitle: existing?.shellTitle ?? tab.shellTitle ?? tab.title,
    customTitle: existing?.customTitle ?? tab.customTitle,
    shell: tab.shell,
    cwd: tab.cwd,
    buffer: existing?.buffer ?? tab.buffer,
    scrollY: existing?.scrollY ?? tab.scrollY,
    cursor: existing?.cursor ?? tab.cursor,
    rows: existing?.rows ?? tab.rows,
    cols: existing?.cols ?? tab.cols,
    status: tab.status
  }
}

export class LayoutStore {
  private state: LayoutState = {
    panelTabs: [
      // 默认 tabs: files 和 changes 在右侧面板
      {
        id: 'files',
        type: 'files',
        position: 'right',
        previewFile: null,
        previewFiles: []
      },
      { id: 'changes', type: 'changes', position: 'right' },
      { id: 'session-tree', type: 'session-tree', position: 'right' },
      { id: 'extensions', type: 'extensions', position: 'right' }
    ],
    activeTabId: {
      bottom: null,
      right: 'files'
    },
    sidebarExpanded: true,
    sidebarFolderRecents: false,
    sidebarShowChildSessions: false,
    rightPanelOpen: false,
    rightPanelWidth: 450,
    bottomPanelOpen: false,
    bottomPanelHeight: 250,
    wakeLock: false,
    terminalCopyOnSelect: false,
    terminalRightClickPaste: false
  }
  private subscribers = new Set<Subscriber>()
  private currentTerminalDirectory: string | null = null

  private persistPanelLayout() {
    try {
      const persisted: PersistedPanelLayout = {
        version: 1,
        panelTabs: this.state.panelTabs
          .filter((tab): tab is PanelTab & { type: PersistedPanelTabType } =>
            (PERSISTED_PANEL_TAB_TYPES as readonly string[]).includes(tab.type)
          )
          .map(tab => ({
            id: tab.id,
            type: tab.type,
            position: tab.position,
            title: tab.title
          })),
        activeTabId: { ...this.state.activeTabId },
        rightPanelOpen: this.state.rightPanelOpen,
        bottomPanelOpen: this.state.bottomPanelOpen
      }
      storageSet(STORAGE_KEY_PANEL_LAYOUT, JSON.stringify(persisted))
    } catch {
      // ignore
    }
  }

  constructor() {
    // 从 localStorage 恢复状态
    try {
      // 侧边栏
      const savedSidebar = storageGet(STORAGE_KEY_SIDEBAR)
      if (savedSidebar !== null) {
        this.state.sidebarExpanded = savedSidebar !== 'false'
      }

      const savedFolderRecents = storageGet(STORAGE_KEY_SIDEBAR_FOLDER_RECENTS)
      if (savedFolderRecents !== null) {
        this.state.sidebarFolderRecents = savedFolderRecents === 'true'
      }

      const savedShowChildSessions = storageGet(STORAGE_KEY_SIDEBAR_SHOW_CHILD_SESSIONS)
      if (savedShowChildSessions !== null) {
        this.state.sidebarShowChildSessions = savedShowChildSessions === 'true'
      }

      const savedWakeLock = storageGet(STORAGE_KEY_WAKE_LOCK)
      if (savedWakeLock !== null) {
        this.state.wakeLock = savedWakeLock === 'true'
      }

      const savedTerminalCopyOnSelect = storageGet('piui-terminal-copy-on-select')
      if (savedTerminalCopyOnSelect !== null) this.state.terminalCopyOnSelect = savedTerminalCopyOnSelect === 'true'
      const savedTerminalRightClickPaste = storageGet('piui-terminal-right-click-paste')
      if (savedTerminalRightClickPaste !== null) this.state.terminalRightClickPaste = savedTerminalRightClickPaste === 'true'

      // 右侧面板宽度
      const savedWidth = storageGet(STORAGE_KEY_RIGHT_PANEL_WIDTH)
      if (savedWidth) {
        const width = parseInt(savedWidth)
        if (!isNaN(width) && width >= 160 && width <= MAX_RIGHT_PANEL_WIDTH) {
          this.state.rightPanelWidth = width
        }
      }

      // 底部面板高度
      const savedBottomHeight = storageGet(STORAGE_KEY_BOTTOM_PANEL_HEIGHT)
      if (savedBottomHeight) {
        const height = parseInt(savedBottomHeight)
        if (!isNaN(height) && height >= 100 && height <= 500) {
          this.state.bottomPanelHeight = height
        }
      }

      const savedPanelLayout = storageGet(STORAGE_KEY_PANEL_LAYOUT)
      if (savedPanelLayout) {
        const restored = sanitizePersistedPanelLayout(JSON.parse(savedPanelLayout))
        if (restored) {
          this.state.panelTabs = restored.panelTabs.map(normalizePersistedPanelTab)
          this.state.activeTabId = { ...restored.activeTabId }
          this.state.rightPanelOpen = restored.rightPanelOpen
          this.state.bottomPanelOpen = restored.bottomPanelOpen
        }
      }
      if (!this.state.panelTabs.some(tab => tab.type === 'session-tree')) {
        this.state.panelTabs.push({
          id: 'session-tree',
          type: 'session-tree',
          position: 'right'
        })
      }
    } catch {
      // ignore
    }
  }

  // ============================================
  // Subscription
  // ============================================

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  private notify() {
    this.persistPanelLayout()
    this.persistTerminalLayout()
    this.subscribers.forEach(fn => fn())
  }

  private persistTerminalLayout() {
    if (!this.currentTerminalDirectory) return

    const raw = storageGet(STORAGE_KEY_TERMINAL_LAYOUT)
    let layoutMap: PersistedTerminalLayoutMap
    try {
      layoutMap = sanitizePersistedTerminalLayoutMap(raw ? JSON.parse(raw) : null)
    } catch {
      layoutMap = { version: 1, directories: {} }
    }

    layoutMap.directories[this.currentTerminalDirectory] = {
      order: {
        bottom: this.getTabsForPosition('bottom').map(tab => tab.id),
        right: this.getTabsForPosition('right').map(tab => tab.id)
      },
      activeTabId: { ...this.state.activeTabId },
      sessions: Object.fromEntries(
        this.state.panelTabs
          .filter((tab): tab is PanelTab & { type: 'terminal' } => tab.type === 'terminal')
          .map(tab => [
            tab.id,
            {
              title: tab.title,
              shellTitle: tab.shellTitle,
              customTitle: tab.customTitle,
              buffer: tab.buffer,
              scrollY: tab.scrollY,
              cursor: tab.cursor,
              rows: tab.rows,
              cols: tab.cols
            }
          ])
      )
    }
    storageSet(STORAGE_KEY_TERMINAL_LAYOUT, JSON.stringify(layoutMap))
  }

  // ============================================
  // Sidebar
  // ============================================

  getSidebarExpanded(): boolean {
    return this.state.sidebarExpanded
  }

  setSidebarExpanded(expanded: boolean) {
    if (this.state.sidebarExpanded === expanded) return
    this.state.sidebarExpanded = expanded
    try {
      storageSet(STORAGE_KEY_SIDEBAR, String(expanded))
    } catch {
      // ignore
    }
    this.notify()
  }

  setSidebarFolderRecents(enabled: boolean) {
    if (this.state.sidebarFolderRecents === enabled) return
    this.state.sidebarFolderRecents = enabled
    try {
      storageSet(STORAGE_KEY_SIDEBAR_FOLDER_RECENTS, String(enabled))
    } catch {
      // ignore
    }
    this.notify()
  }

  setSidebarShowChildSessions(enabled: boolean) {
    if (this.state.sidebarShowChildSessions === enabled) return
    this.state.sidebarShowChildSessions = enabled
    try {
      storageSet(STORAGE_KEY_SIDEBAR_SHOW_CHILD_SESSIONS, String(enabled))
    } catch {
      /* ignore */
    }
    this.notify()
  }

  setWakeLock(enabled: boolean) {
    if (this.state.wakeLock === enabled) return
    this.state.wakeLock = enabled
    try {
      storageSet(STORAGE_KEY_WAKE_LOCK, String(enabled))
    } catch {
      /* ignore */
    }
    this.notify()
  }

  setTerminalCopyOnSelect(enabled: boolean) {
    if (this.state.terminalCopyOnSelect === enabled) return
    this.state.terminalCopyOnSelect = enabled
    storageSet('piui-terminal-copy-on-select', String(enabled))
    this.notify()
  }

  setTerminalRightClickPaste(enabled: boolean) {
    if (this.state.terminalRightClickPaste === enabled) return
    this.state.terminalRightClickPaste = enabled
    storageSet('piui-terminal-right-click-paste', String(enabled))
    this.notify()
  }

  toggleSidebar() {
    this.setSidebarExpanded(!this.state.sidebarExpanded)
  }

  // ============================================
  // 辅助方法
  // ============================================

  /** 设置指定位置面板的开关状态 */
  private setPanelOpen(position: PanelPosition, open: boolean) {
    if (position === 'bottom') {
      this.state.bottomPanelOpen = open
    } else {
      this.state.rightPanelOpen = open
    }
  }

  // ============================================
  // 新的统一 Panel Tab API
  // ============================================

  // 获取指定位置的所有 tabs
  getTabsForPosition(position: PanelPosition): PanelTab[] {
    return this.state.panelTabs.filter(t => t.position === position)
  }

  // 获取指定位置的活动 tab
  getActiveTab(position: PanelPosition): PanelTab | null {
    const activeId = this.state.activeTabId[position]
    if (!activeId) return null
    return this.state.panelTabs.find(t => t.id === activeId && t.position === position) ?? null
  }

  // 设置活动 tab
  setActiveTab(position: PanelPosition, tabId: string) {
    const tab = this.state.panelTabs.find(t => t.id === tabId && t.position === position)
    if (tab) {
      this.state.activeTabId[position] = tabId
      this.notify()
    }
  }

  // 添加新 tab
  addTab(tab: Omit<PanelTab, 'id'> & { id?: string }, openPanel = true) {
    const id = tab.id ?? `${tab.type}-${Date.now()}`
    const newTab: PanelTab = { ...tab, id }
    this.state.panelTabs.push(newTab)
    this.state.activeTabId[tab.position] = id

    if (openPanel) {
      this.setPanelOpen(tab.position, true)
    }
    this.notify()
    return id
  }

  /**
   * 添加单例 tab（同一类型全局只允许一个）
   * 已存在于其他位置时移动到目标位置，已存在于本位置时激活
   */
  private addSingletonTab(type: PanelTab['type'], position: PanelPosition, fixedId?: string): string {
    if (fixedId) {
      const existingAnywhere = this.state.panelTabs.find(t => t.id === fixedId)
      if (existingAnywhere) {
        if (existingAnywhere.position !== position) {
          this.moveTab(existingAnywhere.id, position)
        } else {
          this.setActiveTab(position, existingAnywhere.id)
          this.setPanelOpen(position, true)
          this.notify()
        }
        return existingAnywhere.id
      }
    }
    const existing = this.state.panelTabs.find(t => t.type === type && t.position === position)
    if (existing) {
      this.setActiveTab(position, existing.id)
      this.setPanelOpen(position, true)
      this.notify()
      return existing.id
    }
    return this.addTab({ type, position, ...(fixedId && { id: fixedId }) })
  }

  // 添加 Files 标签
  addFilesTab(position: PanelPosition) {
    return this.addTab({
      type: 'files',
      position,
      previewFile: null,
      previewFiles: []
    })
  }

  // 添加 Changes 标签
  addChangesTab(position: PanelPosition) {
    return this.addTab({ type: 'changes', position })
  }

  addSessionTreeTab(position: PanelPosition = 'right') {
    return this.addSingletonTab('session-tree', position, 'session-tree')
  }

  addSessionControlsTab(position: PanelPosition = 'right') {
    return this.addSingletonTab('session-controls', position, 'session-controls')
  }

  // 添加 MCP 标签
  // 添加 Skill 标签
  addSkillTab(position: PanelPosition) {
    return this.addSingletonTab('skill', position, 'skill')
  }

  addExtensionsTab(position: PanelPosition) {
    return this.addSingletonTab('extensions', position, `extensions-${position}`)
  }

  // 添加 Worktree 标签
  // 移除 tab
  removeTab(tabId: string) {
    const index = this.state.panelTabs.findIndex(t => t.id === tabId)
    if (index === -1) return

    const tab = this.state.panelTabs[index]
    const position = tab.position
    this.state.panelTabs.splice(index, 1)

    // 如果关闭的是当前活动 tab，切换到同位置的相邻 tab
    if (this.state.activeTabId[position] === tabId) {
      const remainingTabs = this.getTabsForPosition(position)
      const newIndex = Math.min(index, remainingTabs.length - 1)
      this.state.activeTabId[position] = remainingTabs[newIndex]?.id ?? null
    }

    // 如果该位置没有 tab 了，关闭面板
    if (this.getTabsForPosition(position).length === 0) {
      this.setPanelOpen(position, false)
    }

    this.notify()
  }

  // 更新 tab 属性
  updateTab(tabId: string, updates: Partial<Omit<PanelTab, 'id' | 'type'>>) {
    const tab = this.state.panelTabs.find(t => t.id === tabId)
    if (tab) {
      Object.assign(tab, updates)
      this.notify()
    }
  }

  // 移动 tab 到另一个位置
  moveTab(tabId: string, toPosition: PanelPosition) {
    const tab = this.state.panelTabs.find(t => t.id === tabId)
    if (!tab || tab.position === toPosition) return

    const fromPosition = tab.position

    // 更新位置
    tab.position = toPosition

    // 更新活动状态
    // 如果原位置的 activeTab 是这个 tab，切换到其他 tab
    if (this.state.activeTabId[fromPosition] === tabId) {
      const remainingTabs = this.getTabsForPosition(fromPosition)
      this.state.activeTabId[fromPosition] = remainingTabs[0]?.id ?? null
    }

    // 新位置设为活动
    this.state.activeTabId[toPosition] = tabId

    // 打开目标面板
    if (toPosition === 'bottom') {
      this.state.bottomPanelOpen = true
    } else {
      this.state.rightPanelOpen = true
    }

    // 如果原位置空了，关闭面板
    if (this.getTabsForPosition(fromPosition).length === 0) {
      if (fromPosition === 'bottom') {
        this.state.bottomPanelOpen = false
      } else {
        this.state.rightPanelOpen = false
      }
    }

    this.notify()
  }

  // 重新排序同位置的 tabs
  reorderTabs(position: PanelPosition, draggedId: string, targetId: string) {
    const tabs = this.state.panelTabs
    const draggedIndex = tabs.findIndex(t => t.id === draggedId && t.position === position)
    const targetIndex = tabs.findIndex(t => t.id === targetId && t.position === position)

    if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
      return
    }

    const [draggedTab] = tabs.splice(draggedIndex, 1)
    tabs.splice(targetIndex, 0, draggedTab)

    this.notify()
  }

  // ============================================
  // 兼容旧 API - Right Panel
  // ============================================

  // 获取当前 rightPanelView (兼容)
  get rightPanelView(): RightPanelView {
    const activeTab = this.getActiveTab('right')
    if (activeTab?.type === 'files' || activeTab?.type === 'changes') {
      return activeTab.type
    }
    return 'files'
  }

  toggleRightPanel(view?: RightPanelView) {
    if (view) {
      const currentView = this.rightPanelView
      if (view !== currentView) {
        this.setRightPanelView(view)
        this.state.rightPanelOpen = true
      } else if (this.state.rightPanelOpen) {
        this.state.rightPanelOpen = false
      } else {
        this.state.rightPanelOpen = true
      }
    } else {
      this.state.rightPanelOpen = !this.state.rightPanelOpen
    }
    this.notify()
  }

  openRightPanel(view?: RightPanelView) {
    this.state.rightPanelOpen = true
    if (view) {
      this.setRightPanelView(view)
    } else {
      this.notify()
    }
  }

  closeRightPanel() {
    this.state.rightPanelOpen = false
    this.notify()
  }

  setRightPanelView(view: RightPanelView) {
    // 找到该 view 对应的 tab 并激活
    const tab = this.state.panelTabs.find(t => t.type === view && t.position === 'right')
    if (tab) {
      this.state.activeTabId.right = tab.id
    }
    this.notify()
  }

  setRightPanelWidth(width: number) {
    this.state.rightPanelWidth = Math.min(Math.max(width, 160), MAX_RIGHT_PANEL_WIDTH)
    try {
      storageSet(STORAGE_KEY_RIGHT_PANEL_WIDTH, this.state.rightPanelWidth.toString())
    } catch {
      // ignore
    }
    this.notify()
  }

  // ============================================
  // File Preview Actions
  // ============================================

  openFilePreview(file: PreviewFile, position?: PanelPosition) {
    const targetTab = this.getTargetFilesTab(position)
    if (!targetTab) return

    const previewFiles = targetTab.previewFiles ?? []
    const existingIndex = previewFiles.findIndex(item => item.path === file.path)
    const nextPreviewFiles =
      existingIndex === -1 ? [...previewFiles, file] : previewFiles.map(item => (item.path === file.path ? file : item))

    targetTab.previewFiles = nextPreviewFiles
    targetTab.previewFile = file
    this.state.activeTabId[targetTab.position] = targetTab.id
    this.setPanelOpen(targetTab.position, true)
    this.notify()
  }

  activateFilePreview(tabId: string, path: string) {
    const tab = this.state.panelTabs.find(item => item.id === tabId && item.type === 'files')
    const file = tab?.previewFiles?.find(item => item.path === path)
    if (!tab || !file) return
    tab.previewFile = file
    this.notify()
  }

  closeFilePreview(tabId: string, path?: string) {
    const tab = this.state.panelTabs.find(item => item.id === tabId && item.type === 'files')
    const previewFiles = tab?.previewFiles
    const targetPath = path ?? tab?.previewFile?.path
    if (!tab || !previewFiles || !targetPath) return

    const index = previewFiles.findIndex(item => item.path === targetPath)
    if (index === -1) return

    const isActive = tab.previewFile?.path === targetPath
    const nextPreviewFiles = previewFiles.filter(item => item.path !== targetPath)

    tab.previewFiles = nextPreviewFiles

    if (nextPreviewFiles.length === 0) {
      tab.previewFile = null
    } else if (isActive) {
      const nextIndex = Math.min(index, nextPreviewFiles.length - 1)
      tab.previewFile = nextPreviewFiles[nextIndex] ?? null
    }

    this.notify()
  }

  closeAllFilePreviews(tabId: string) {
    const tab = this.state.panelTabs.find(item => item.id === tabId && item.type === 'files')
    if (!tab) return
    tab.previewFile = null
    tab.previewFiles = []
    this.notify()
  }

  reorderFilePreviews(tabId: string, draggedPath: string, targetPath: string) {
    const tab = this.state.panelTabs.find(item => item.id === tabId && item.type === 'files')
    const previewFiles = tab?.previewFiles
    if (!tab || !previewFiles) return

    const draggedIndex = previewFiles.findIndex(item => item.path === draggedPath)
    const targetIndex = previewFiles.findIndex(item => item.path === targetPath)

    if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) return

    const nextPreviewFiles = [...previewFiles]
    const [dragged] = nextPreviewFiles.splice(draggedIndex, 1)
    nextPreviewFiles.splice(targetIndex, 0, dragged)
    tab.previewFiles = nextPreviewFiles
    this.notify()
  }

  private getTargetFilesTab(position?: PanelPosition): PanelTab | null {
    if (position) {
      const activeId = this.state.activeTabId[position]
      const activeFilesTab = this.state.panelTabs.find(t => t.id === activeId && t.type === 'files' && t.position === position)
      if (activeFilesTab) return activeFilesTab

      const filesTab = this.state.panelTabs.find(t => t.type === 'files' && t.position === position)
      if (filesTab) return filesTab

      const id = this.addFilesTab(position)
      return this.state.panelTabs.find(t => t.id === id) ?? null
    }

    const preferred = (['right', 'bottom'] as const)
      .map(pos => this.state.panelTabs.find(t => t.id === this.state.activeTabId[pos] && t.type === 'files' && t.position === pos))
      .find(Boolean)
    if (preferred) return preferred

    return this.state.panelTabs.find(t => t.type === 'files') ?? null
  }

  // ============================================
  // 兼容旧 API - Bottom Panel
  // ============================================

  setCurrentTerminalDirectory(directory?: string) {
    const nextDirectory = directory || null
    if (this.currentTerminalDirectory === nextDirectory) return
    this.persistTerminalLayout()
    this.currentTerminalDirectory = nextDirectory
  }

  syncTerminalSessions(directory: string | undefined, sessions: TerminalInfo[]) {
    const nextDirectory = directory || null
    const directoryChanged = this.currentTerminalDirectory !== nextDirectory
    if (directoryChanged) {
      this.persistTerminalLayout()
      this.currentTerminalDirectory = nextDirectory
    }

    let layoutMap: PersistedTerminalLayoutMap = { version: 1, directories: {} }
    const rawLayout = storageGet(STORAGE_KEY_TERMINAL_LAYOUT)
    try {
      layoutMap = sanitizePersistedTerminalLayoutMap(rawLayout ? JSON.parse(rawLayout) : null)
    } catch {
      // Ignore malformed terminal layout data and rebuild the current directory.
    }

    const savedLayout = directory ? layoutMap.directories[directory] : undefined
    const existingTerminalById = new Map(this.state.panelTabs.filter(tab => tab.type === 'terminal').map(tab => [tab.id, tab]))
    const sessionById = new Map(
      sessions.map(session => {
        const previous = existingTerminalById.get(session.id)
        const saved = savedLayout?.sessions?.[session.id]
        const terminal: TerminalTab = {
          id: session.id,
          title: saved?.title ?? previous?.title ?? session.title,
          customTitle: saved?.customTitle ?? previous?.customTitle,
          shellTitle: saved?.shellTitle ?? previous?.shellTitle ?? session.shell,
          shell: session.shell,
          cwd: session.cwd,
          status: session.status === 'running' ? (previous?.status === 'connected' ? 'connected' : 'disconnected') : 'exited',
          buffer: saved?.buffer ?? previous?.buffer,
          scrollY: saved?.scrollY ?? previous?.scrollY,
          cursor: saved?.cursor ?? previous?.cursor ?? session.cursor,
          rows: saved?.rows ?? previous?.rows,
          cols: saved?.cols ?? previous?.cols
        }
        return [session.id, terminal] as const
      })
    )

    const nonTerminalTabs = this.state.panelTabs.filter(tab => tab.type !== 'terminal')
    const nonTerminalById = new Map(nonTerminalTabs.map(tab => [tab.id, tab]))
    const orderByPosition: Record<PanelPosition, string[]> = {
      bottom: savedLayout?.order.bottom ? [...savedLayout.order.bottom] : [],
      right: savedLayout?.order.right ? [...savedLayout.order.right] : []
    }

    for (const position of PANEL_POSITIONS) {
      for (const id of nonTerminalTabs.filter(tab => tab.position === position).map(tab => tab.id)) {
        if (!orderByPosition[position].includes(id)) orderByPosition[position].push(id)
      }
    }

    const assignedTerminalIds = new Set<string>()
    const tabsByPosition: Record<PanelPosition, PanelTab[]> = {
      bottom: [],
      right: []
    }
    for (const position of PANEL_POSITIONS) {
      for (const id of orderByPosition[position]) {
        const nonTerminalTab = nonTerminalById.get(id)
        if (nonTerminalTab && nonTerminalTab.position === position) {
          tabsByPosition[position].push(nonTerminalTab)
          continue
        }

        const terminalTab = sessionById.get(id)
        if (terminalTab && !assignedTerminalIds.has(id)) {
          tabsByPosition[position].push(buildTerminalPanelTab(terminalTab, position, existingTerminalById.get(id)))
          assignedTerminalIds.add(id)
        }
      }
    }

    for (const session of sessions) {
      if (assignedTerminalIds.has(session.id)) continue
      const terminal = sessionById.get(session.id)
      if (terminal) tabsByPosition.bottom.push(buildTerminalPanelTab(terminal, 'bottom', existingTerminalById.get(session.id)))
    }

    this.state.panelTabs = [...tabsByPosition.right, ...tabsByPosition.bottom]
    for (const position of PANEL_POSITIONS) {
      const savedActiveId = savedLayout?.activeTabId[position]
      const hasSavedActive = savedActiveId
        ? this.state.panelTabs.some(tab => tab.id === savedActiveId && tab.position === position)
        : false

      if (directoryChanged) {
        this.state.activeTabId[position] = hasSavedActive ? (savedActiveId ?? null) : (this.getTabsForPosition(position)[0]?.id ?? null)
        continue
      }

      const currentActiveId = this.state.activeTabId[position]
      const hasCurrentActive = currentActiveId
        ? this.state.panelTabs.some(tab => tab.id === currentActiveId && tab.position === position)
        : false
      if (hasCurrentActive) continue

      this.state.activeTabId[position] = hasSavedActive ? (savedActiveId ?? null) : (this.getTabsForPosition(position)[0]?.id ?? null)
    }
    this.notify()
  }

  addTerminalTab(tab: TerminalTab, openPanel = true, position: PanelPosition = 'bottom') {
    const existing = this.state.panelTabs.find(item => item.id === tab.id && item.type === 'terminal')
    if (existing) {
      Object.assign(existing, {
        terminalId: tab.id,
        shellTitle: existing.shellTitle ?? tab.shellTitle ?? tab.shell ?? tab.title,
        shell: tab.shell,
        cwd: tab.cwd,
        status: tab.status
      })
      if (!existing.customTitle) existing.title = tab.title
      existing.position = position
      this.state.activeTabId[position] = tab.id
      if (openPanel) this.setPanelOpen(position, true)
      this.notify()
      return
    }
    this.addTab(buildTerminalPanelTab(tab, position), openPanel)
  }

  removeTerminalTab(id: string) {
    this.removeTab(id)
  }

  updateTerminalTab(id: string, updates: Partial<Omit<TerminalTab, 'id'>>) {
    const tab = this.state.panelTabs.find(item => item.id === id && item.type === 'terminal')
    if (!tab) return
    Object.assign(tab, updates)
    this.notify()
  }

  updateTerminalShellTitle(id: string, shellTitle: string, manualMode: boolean) {
    const tab = this.state.panelTabs.find(item => item.id === id && item.type === 'terminal')
    if (!tab) return
    tab.shellTitle = shellTitle
    if (!manualMode) tab.title = shellTitle
    this.notify()
  }

  updateTerminalCustomTitle(id: string, customTitle: string) {
    const tab = this.state.panelTabs.find(item => item.id === id && item.type === 'terminal')
    if (!tab) return
    tab.customTitle = customTitle
    tab.title = customTitle
    this.notify()
  }

  syncTerminalTitleMode(manualMode: boolean) {
    let changed = false
    for (const tab of this.state.panelTabs) {
      if (tab.type !== 'terminal') continue
      const nextTitle = manualMode ? (tab.customTitle ?? tab.title) : (tab.shellTitle ?? tab.title)
      if (tab.title !== nextTitle) {
        tab.title = nextTitle
        changed = true
      }
    }
    if (changed) this.notify()
  }

  updateTerminalSnapshot(id: string, snapshot: Pick<PanelTab, 'buffer' | 'scrollY' | 'cursor' | 'rows' | 'cols'>) {
    const tab = this.state.panelTabs.find(item => item.id === id && item.type === 'terminal')
    if (!tab) return
    if (
      tab.buffer === snapshot.buffer &&
      tab.scrollY === snapshot.scrollY &&
      tab.cursor === snapshot.cursor &&
      tab.rows === snapshot.rows &&
      tab.cols === snapshot.cols
    ) {
      return
    }
    Object.assign(tab, snapshot)
    this.notify()
  }

  toggleBottomPanel() {
    this.state.bottomPanelOpen = !this.state.bottomPanelOpen
    this.notify()
  }

  openBottomPanel() {
    this.state.bottomPanelOpen = true
    this.notify()
  }

  closeBottomPanel() {
    this.state.bottomPanelOpen = false
    this.notify()
  }

  setBottomPanelHeight(height: number) {
    this.state.bottomPanelHeight = height
    try {
      storageSet('piui-bottom-panel-height', height.toString())
    } catch {
      // ignore
    }
    this.notify()
  }

  // ============================================
  getState() {
    return this.state
  }
}

export const layoutStore = new LayoutStore()

export interface LayoutBackup {
  sidebarExpanded: boolean
  sidebarFolderRecents: boolean
  sidebarShowChildSessions: boolean
  wakeLock: boolean
  rightPanelWidth: number
  bottomPanelHeight: number
  panelLayout: PersistedPanelLayout
  terminalLayout: PersistedTerminalLayoutMap
  sidebarWidth: number | null
}

function buildPersistedPanelLayout(state: LayoutState): PersistedPanelLayout {
  return {
    version: 1,
    panelTabs: state.panelTabs
      .filter((tab): tab is PanelTab & { type: PersistedPanelTabType } =>
        (PERSISTED_PANEL_TAB_TYPES as readonly string[]).includes(tab.type)
      )
      .map(tab => ({
        id: tab.id,
        type: tab.type,
        position: tab.position,
        title: tab.title
      })),
    activeTabId: { ...state.activeTabId },
    rightPanelOpen: state.rightPanelOpen,
    bottomPanelOpen: state.bottomPanelOpen
  }
}

export function exportLayoutBackup(): LayoutBackup {
  const state = layoutStore.getState()
  const rawSidebarWidth = storageGet(STORAGE_KEY_VIEWPORT_SIDEBAR_WIDTH)
  const sidebarWidth = rawSidebarWidth !== null ? Number.parseInt(rawSidebarWidth, 10) : null
  const rawTerminalLayout = storageGet(STORAGE_KEY_TERMINAL_LAYOUT)
  let terminalLayout: PersistedTerminalLayoutMap
  try {
    terminalLayout = sanitizePersistedTerminalLayoutMap(rawTerminalLayout ? JSON.parse(rawTerminalLayout) : null)
  } catch {
    terminalLayout = { version: 1, directories: {} }
  }

  return {
    sidebarExpanded: state.sidebarExpanded,
    sidebarFolderRecents: state.sidebarFolderRecents,
    sidebarShowChildSessions: state.sidebarShowChildSessions,
    wakeLock: state.wakeLock,
    rightPanelWidth: state.rightPanelWidth,
    bottomPanelHeight: state.bottomPanelHeight,
    panelLayout: buildPersistedPanelLayout(state),
    terminalLayout,
    sidebarWidth: Number.isFinite(sidebarWidth) ? sidebarWidth : null
  }
}

export function importLayoutBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const panelLayout = sanitizePersistedPanelLayout(parsed?.panelLayout) ?? buildPersistedPanelLayout(layoutStore.getState())
  const terminalLayout = sanitizePersistedTerminalLayoutMap(parsed?.terminalLayout)
  const rightPanelWidth =
    typeof parsed?.rightPanelWidth === 'number' ? Math.min(Math.max(Math.round(parsed.rightPanelWidth), 160), MAX_RIGHT_PANEL_WIDTH) : 450
  const bottomPanelHeight =
    typeof parsed?.bottomPanelHeight === 'number' ? Math.min(Math.max(Math.round(parsed.bottomPanelHeight), 100), 500) : 250
  const sidebarWidth =
    typeof parsed?.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth) && parsed.sidebarWidth > 0
      ? Math.round(parsed.sidebarWidth)
      : null

  storageSet(STORAGE_KEY_SIDEBAR, String(parsed?.sidebarExpanded === true))
  storageSet(STORAGE_KEY_SIDEBAR_FOLDER_RECENTS, String(parsed?.sidebarFolderRecents === true))
  storageSet(STORAGE_KEY_SIDEBAR_SHOW_CHILD_SESSIONS, String(parsed?.sidebarShowChildSessions === true))
  storageSet(STORAGE_KEY_WAKE_LOCK, String(parsed?.wakeLock === true))
  storageSet(STORAGE_KEY_RIGHT_PANEL_WIDTH, String(rightPanelWidth))
  storageSet(STORAGE_KEY_BOTTOM_PANEL_HEIGHT, String(bottomPanelHeight))
  storageSet(STORAGE_KEY_PANEL_LAYOUT, JSON.stringify(panelLayout))
  storageSet(STORAGE_KEY_TERMINAL_LAYOUT, JSON.stringify(terminalLayout))

  if (sidebarWidth !== null) {
    storageSet(STORAGE_KEY_VIEWPORT_SIDEBAR_WIDTH, String(sidebarWidth))
  } else {
    storageRemove(STORAGE_KEY_VIEWPORT_SIDEBAR_WIDTH)
  }
}

// ============================================
// React Hook
// ============================================

import { useSyncExternalStore } from 'react'

// 兼容的 snapshot 类型，包含派生属性
interface LayoutSnapshot extends LayoutState {
  // 派生属性 - 兼容旧组件
  rightPanelView: RightPanelView
}

let cachedSnapshot: LayoutSnapshot | null = null

function getSnapshot(): LayoutSnapshot {
  if (!cachedSnapshot) {
    const state = layoutStore.getState()
    cachedSnapshot = {
      ...state,
      // 派生属性
      rightPanelView: layoutStore.rightPanelView
    }
  }
  return cachedSnapshot
}

// 订阅更新时清除缓存
layoutStore.subscribe(() => {
  cachedSnapshot = null
})

export function useLayoutStore() {
  return useSyncExternalStore(cb => layoutStore.subscribe(cb), getSnapshot, getSnapshot)
}
