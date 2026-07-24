import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from './FileExplorer'
import type { DesktopPlatform } from '../utils/tauri'

const {
  useFileExplorerMock,
  isTauriMock,
  isTauriMobileMock,
  getDesktopPlatformMock,
  revealItemInDirMock,
} = vi.hoisted(() => ({
  useFileExplorerMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
  isTauriMobileMock: vi.fn(() => false),
  getDesktopPlatformMock: vi.fn((): DesktopPlatform => 'windows'),
  revealItemInDirMock: vi.fn(async (_path: string | string[]) => {}),
}))

vi.mock('../hooks', () => ({
  useFileExplorer: (options?: unknown) => useFileExplorerMock(options),
}))

vi.mock('../hooks/useVerticalSplitResize', () => ({
  useVerticalSplitResize: () => ({
    splitHeight: 200,
    isResizing: false,
    resetSplitHeight: vi.fn(),
    handleResizeStart: vi.fn(),
    handleTouchResizeStart: vi.fn(),
  }),
}))

vi.mock('../utils/tauri', () => ({
  isTauri: () => isTauriMock(),
  isTauriMobile: () => isTauriMobileMock(),
  getDesktopPlatform: () => getDesktopPlatformMock(),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: (path: string | string[]) => revealItemInDirMock(path),
}))

vi.mock('../lib/internalDragCore', () => ({
  startInternalDrag: vi.fn(),
}))

describe('FileExplorer', () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    isTauriMobileMock.mockReturnValue(false)
    getDesktopPlatformMock.mockReturnValue('windows')
    revealItemInDirMock.mockClear()
    useFileExplorerMock.mockReturnValue({
      tree: [
        {
          name: 'app.ts',
          path: 'src/app.ts',
          absolute: 'C:/repo/src/app.ts',
          type: 'file',
          ignored: false,
        },
      ],
      isLoading: false,
      error: null,
      expandedPaths: new Set<string>(),
      toggleExpand: vi.fn(),
      refresh: vi.fn(),
      previewContent: null,
      previewLoading: false,
      previewError: null,
      loadPreview: vi.fn(),
      clearPreview: vi.fn(),
      fileStatus: new Map(),
    })
  })

  it('reveals the selected file in the system explorer from the context menu', async () => {
    render(
      <FileExplorer
        panelTabId="files-1"
        directory="C:/repo"
        previewFile={null}
        previewFiles={[]}
        position="right"
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in File Explorer' }))

    await waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith('C:/repo/src/app.ts')
    })
  })

  it('hides the reveal action outside desktop Tauri', () => {
    isTauriMock.mockReturnValue(false)

    render(
      <FileExplorer
        panelTabId="files-1"
        directory="C:/repo"
        previewFile={null}
        previewFiles={[]}
        position="right"
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    expect(screen.queryByRole('button', { name: 'Reveal in File Explorer' })).not.toBeInTheDocument()
  })

  it('uses Finder wording on macOS', async () => {
    getDesktopPlatformMock.mockReturnValue('macos')

    render(
      <FileExplorer
        panelTabId="files-1"
        directory="C:/repo"
        previewFile={null}
        previewFiles={[]}
        position="right"
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: 'app.ts' }))
    expect(screen.getByRole('button', { name: 'Reveal in Finder' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))
    })

    await waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith('C:/repo/src/app.ts')
    })
  })
})
