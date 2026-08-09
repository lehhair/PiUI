import { render, screen, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatViewportProvider, useChatViewportSelect, type ChatViewportValue } from './chatViewport'

function makeValue(overrides: Partial<ChatViewportValue> = {}): ChatViewportValue {
  return {
    presentation: { surfaceVariant: 'desktop', isCompact: false },
    interaction: {
      mode: 'pointer',
      touchCapable: false,
      sidebarBehavior: 'docked',
      rightPanelBehavior: 'docked',
      bottomPanelBehavior: 'docked',
      outlineInteraction: 'pointer',
      enableCollapsedInputDock: false,
    },
    layout: {
      viewportWidth: 1280,
      viewportHeight: 800,
      surfaceWidth: 800,
      surfaceMinWidth: 380,
      sidebar: {
        railWidth: 48,
        requestedWidth: 288,
        openWidth: 288,
        dockedWidth: 288,
        overlayWidth: 288,
        hardMinWidth: 240,
        preferredMinWidth: 260,
        maxWidth: 512,
        resizeMaxWidth: 512,
      },
      rightPanel: {
        requestedWidth: 400,
        dockedWidth: 400,
        hardMinWidth: 320,
        maxWidth: 600,
        resizeMaxWidth: 600,
      },
      bottomPanel: { maxHeight: 400 },
    },
    actions: { setSidebarRequestedWidth: vi.fn() },
    ...overrides,
  }
}

describe('useChatViewportSelect', () => {
  it('keeps the DOM node when an unselected field changes (width resize)', async () => {
    function Probe() {
      const isCompact = useChatViewportSelect(value => value.presentation.isCompact)
      return <div data-testid="probe">{String(isCompact)}</div>
    }
    function App({ value }: { value: ChatViewportValue }) {
      return (
        <ChatViewportProvider value={value}>
          <Probe />
        </ChatViewportProvider>
      )
    }
    const { rerender, container } = render(<App value={makeValue()} />)
    await act(async () => {})
    const firstNode = container.querySelector('[data-testid="probe"]')!
    expect(firstNode.textContent).toBe('false')

    // 宽度变化：surfaceWidth/viewportWidth 变，但 isCompact 不变 → DOM 节点复用（bail out）
    await act(async () => {
      rerender(
        <App
          value={makeValue({
            layout: { ...makeValue().layout, surfaceWidth: 900, viewportWidth: 1400 },
          })}
        />,
      )
    })
    const afterResize = container.querySelector('[data-testid="probe"]')!
    expect(afterResize).toBe(firstNode)
    expect(afterResize.textContent).toBe('false')
  })

  it('updates the DOM when the selected field flips', async () => {
    function Probe() {
      const isCompact = useChatViewportSelect(value => value.presentation.isCompact)
      return <div data-testid="probe">{String(isCompact)}</div>
    }
    function App({ value }: { value: ChatViewportValue }) {
      return (
        <ChatViewportProvider value={value}>
          <Probe />
        </ChatViewportProvider>
      )
    }
    const { rerender } = render(<App value={makeValue()} />)
    await act(async () => {})
    expect(screen.getByTestId('probe').textContent).toBe('false')

    await act(async () => {
      rerender(<App value={makeValue({ presentation: { surfaceVariant: 'compact', isCompact: true } })} />)
    })
    expect(screen.getByTestId('probe').textContent).toBe('true')
  })

  it('re-renders a consumer subscribed to the width field when width changes', async () => {
    function WideProbe() {
      const surfaceWidth = useChatViewportSelect(value => value.layout.surfaceWidth)
      return <div data-testid="width">{surfaceWidth}</div>
    }
    function App({ value }: { value: ChatViewportValue }) {
      return (
        <ChatViewportProvider value={value}>
          <WideProbe />
        </ChatViewportProvider>
      )
    }
    const { rerender } = render(<App value={makeValue()} />)
    await act(async () => {})
    expect(screen.getByTestId('width').textContent).toBe('800')

    await act(async () => {
      rerender(<App value={makeValue({ layout: { ...makeValue().layout, surfaceWidth: 900 } })} />)
    })
    expect(screen.getByTestId('width').textContent).toBe('900')
  })
})
