import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useInView } from './useInView'

class IntersectionObserverMock {
  static instance: IntersectionObserverMock | null = null
  callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    IntersectionObserverMock.instance = this
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function InViewHarness() {
  const { ref, inView } = useInView()

  return (
    <div>
      <div ref={ref} data-testid="target" />
      <span data-testid="state">{String(inView)}</span>
    </div>
  )
}

describe('useInView', () => {
  const originalObserver = globalThis.IntersectionObserver

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock as unknown as typeof IntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.IntersectionObserver = originalObserver
  })

  it('updates inView when the element intersects', () => {
    render(<InViewHarness />)

    act(() => {
      IntersectionObserverMock.instance?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })

    expect(screen.getByTestId('state')).toHaveTextContent('true')
  })
})
