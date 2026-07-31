import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LayoutStore } from './layoutStore'

const STORAGE_KEY_PANEL_LAYOUT = 'piui-panel-layout'

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
      bottomPanelOpen: true,
    })
    expect(persisted.panelTabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'files', type: 'files', position: 'right' }),
        expect.objectContaining({ id: 'changes', type: 'changes', position: 'right' }),
        expect.objectContaining({ id: 'skill', type: 'skill', position: 'bottom' }),
      ]),
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
      position: 'right',
    })
  })
})
