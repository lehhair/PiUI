import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LayoutStore } from './layoutStore'

const STORAGE_KEY_PANEL_LAYOUT = 'piui-panel-layout'
const STORAGE_KEY_TERMINAL_LAYOUT = 'piui-terminal-layout'

describe('LayoutStore panel layout', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('persists the global panel layout', () => {
    const store = new LayoutStore()

    store.addSkillTab('bottom')
    store.openRightPanel('changes')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY_PANEL_LAYOUT) ?? 'null')

    expect(persisted).toMatchObject({
      version: 1,
      rightPanelOpen: true,
      bottomPanelOpen: true
    })
    expect(persisted.panelTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'files',
          type: 'files',
          position: 'right'
        }),
        expect.objectContaining({
          id: 'changes',
          type: 'changes',
          position: 'right'
        }),
        expect.objectContaining({
          id: 'skill',
          type: 'skill',
          position: 'bottom'
        })
      ])
    )

    const restored = new LayoutStore().getState()
    expect(restored.rightPanelOpen).toBe(true)
    expect(restored.bottomPanelOpen).toBe(true)
    expect(restored.panelTabs.some(tab => tab.id === 'skill' && tab.position === 'bottom')).toBe(true)
  })

  it('keeps session controls as a persisted right-panel singleton', () => {
    const store = new LayoutStore()

    const firstId = store.addSessionControlsTab()
    const secondId = store.addSessionControlsTab()
    store.moveTab(firstId, 'bottom')

    const state = store.getState()
    expect(firstId).toBe('session-controls')
    expect(secondId).toBe(firstId)
    expect(state.panelTabs.filter(tab => tab.type === 'session-controls')).toHaveLength(1)
    expect(state.panelTabs.find(tab => tab.id === firstId)?.position).toBe('right')
    expect(state.activeTabId.right).toBe(firstId)

    const restored = new LayoutStore().getState()
    expect(restored.panelTabs.find(tab => tab.id === firstId)).toMatchObject({
      type: 'session-controls',
      position: 'right'
    })
  })

  it('restores terminal order, active tab, title, and snapshot per workspace', () => {
    const sessions = [
      {
        id: 'term-1',
        title: 'PowerShell',
        shell: 'powershell.exe',
        cwd: 'C:/project',
        status: 'running' as const,
        pid: 1,
        cursor: 0
      }
    ]
    const store = new LayoutStore()

    store.syncTerminalSessions('C:/project', sessions)
    store.moveTab('term-1', 'right')
    store.updateTerminalCustomTitle('term-1', 'Build')
    store.updateTerminalSnapshot('term-1', {
      buffer: 'output',
      scrollY: 4,
      cursor: 7,
      rows: 20,
      cols: 90
    })

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY_TERMINAL_LAYOUT) ?? 'null')
    expect(persisted.directories['C:/project']).toMatchObject({
      order: {
        right: ['files', 'changes', 'session-tree', 'extensions', 'term-1']
      },
      activeTabId: { right: 'term-1' }
    })

    const restored = new LayoutStore()
    restored.syncTerminalSessions('C:/project', sessions)
    expect(restored.getState().panelTabs.find(tab => tab.id === 'term-1')).toMatchObject({
      position: 'right',
      title: 'Build',
      customTitle: 'Build',
      buffer: 'output',
      scrollY: 4,
      cursor: 7,
      rows: 20,
      cols: 90
    })
    expect(restored.getState().activeTabId.right).toBe('term-1')
  })
})
