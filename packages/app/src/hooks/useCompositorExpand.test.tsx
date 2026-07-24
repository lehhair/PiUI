import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPAND_MOTION } from '../constants/expandMotion'
import { COMPOSITOR_GRID_TRANSITION, useCompositorExpand } from './useCompositorExpand'

const { userAgentSpy } = vi.hoisted(() => ({
  userAgentSpy: vi.fn(() => 'Mozilla/5.0'),
}))

Object.defineProperty(navigator, 'userAgent', {
  configurable: true,
  get: () => userAgentSpy(),
})

describe('useCompositorExpand', () => {
  beforeEach(() => {
    userAgentSpy.mockReturnValue('Mozilla/5.0')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses normal grid transition on desktop', () => {
    const { result, rerender } = renderHook(({ open }) => useCompositorExpand(open), {
      initialProps: { open: false },
    })

    expect(result.current.layoutOpen).toBe(false)
    expect(result.current.panelClassName).toBe(EXPAND_MOTION.gridTransition)
    expect(COMPOSITOR_GRID_TRANSITION).toBe(EXPAND_MOTION.gridTransition)
    expect(result.current.keepMounted).toBe(false)

    rerender({ open: true })
    expect(result.current.layoutOpen).toBe(true)
    expect(result.current.keepMounted).toBe(true)
  })

  it('opens layout instantly without grid transition on android expand', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Linux; Android 14)')
    const { result, rerender } = renderHook(({ open }) => useCompositorExpand(open), {
      initialProps: { open: false },
    })

    rerender({ open: true })
    expect(result.current.layoutOpen).toBe(true)
    expect(result.current.keepMounted).toBe(true)
    expect(result.current.panelClassName).toBe('')
  })

  it('switches back to grid transition on android collapse', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Linux; Android 14)')
    const { result, rerender } = renderHook(({ open }) => useCompositorExpand(open), {
      initialProps: { open: true },
    })

    rerender({ open: false })
    expect(result.current.layoutOpen).toBe(false)
    expect(result.current.panelClassName).toContain('transition-')
  })
})
