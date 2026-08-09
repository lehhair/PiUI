import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DesktopTitlebar } from './DesktopTitlebar'

const {
  useThemeMock,
  useUpdateStoreMock,
  hasUpdateAvailableMock,
  getDesktopPlatformMock,
  usesCustomDesktopTitlebarMock,
  getCurrentWindowMock,
} = vi.hoisted(() => ({
  useThemeMock: vi.fn(() => ({ mode: 'dark', resolvedTheme: 'dark' })),
  useUpdateStoreMock: vi.fn(() => ({})),
  hasUpdateAvailableMock: vi.fn(() => false),
  getDesktopPlatformMock: vi.fn(() => 'windows'),
  usesCustomDesktopTitlebarMock: vi.fn(() => true),
  getCurrentWindowMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => useThemeMock(),
}))

vi.mock('../store/updateStore', () => ({
  useUpdateStore: () => useUpdateStoreMock(),
  hasUpdateAvailable: () => hasUpdateAvailableMock(),
}))

vi.mock('../utils/tauri', () => ({
  isTauri: () => false,
  getDesktopPlatform: () => getDesktopPlatformMock(),
  usesCustomDesktopTitlebar: () => usesCustomDesktopTitlebarMock(),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => getCurrentWindowMock(),
}))

function installWindowApiMock(overrides: Partial<Record<'minimize' | 'toggleMaximize' | 'close' | 'isMaximized' | 'onResized', unknown>> = {}) {
  const calls: Record<string, unknown[]> = {}
  const win = {
    minimize: vi.fn(() => {
      calls.minimize = [...(calls.minimize ?? []), []]
    }),
    toggleMaximize: vi.fn(() => {
      calls.toggleMaximize = [...(calls.toggleMaximize ?? []), []]
    }),
    close: vi.fn(() => {
      calls.close = [...(calls.close ?? []), []]
    }),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    ...overrides,
  }
  getCurrentWindowMock.mockReturnValue(win)
  return { win, calls }
}

describe('DesktopTitlebar', () => {
  it('renders self-drawn Windows controls (minimize / maximize / close)', () => {
    installWindowApiMock()
    render(<DesktopTitlebar />)

    expect(screen.getByRole('button', { name: 'desktopTitlebar.minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'desktopTitlebar.maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'desktopTitlebar.close' })).toBeInTheDocument()
  })

  it('calls the Tauri window API when controls are clicked', () => {
    const { calls } = installWindowApiMock()
    render(<DesktopTitlebar />)

    fireEvent.click(screen.getByRole('button', { name: 'desktopTitlebar.minimize' }))
    expect(calls.minimize).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'desktopTitlebar.maximize' }))
    expect(calls.toggleMaximize).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'desktopTitlebar.close' }))
    expect(calls.close).toHaveLength(1)
  })

  it('switches the maximize button to restore when the window is maximized', async () => {
    installWindowApiMock({ isMaximized: vi.fn(async () => true) })
    render(<DesktopTitlebar />)

    expect(await screen.findByRole('button', { name: 'desktopTitlebar.restore' })).toBeInTheDocument()
  })
})
