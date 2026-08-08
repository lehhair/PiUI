// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiResourceManagement } from './PiResourceManagement'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { registryMock, skillsMock, promptsMock, agentsFilesMock, reloadMock } = vi.hoisted(() => ({
  registryMock: vi.fn(),
  skillsMock: vi.fn(),
  promptsMock: vi.fn(),
  agentsFilesMock: vi.fn(),
  reloadMock: vi.fn(),
}))

vi.mock('../../../pi/controllers/index.js', () => ({
  loadPiSessionRegistry: () => registryMock(),
  reloadPiSessionResources: (...args: unknown[]) => reloadMock(...args),
}))

vi.mock('../../../pi/transport/index.js', () => ({
  getPiSkills: () => skillsMock(),
  getPiPrompts: () => promptsMock(),
  getPiAgentsFiles: () => agentsFilesMock(),
}))

const emptyExtensionUi = { sessions: {} }
vi.mock('../../../pi/extensionUiStore', () => ({
  extensionUiStore: {
    subscribe: () => () => {},
    getSnapshot: () => emptyExtensionUi,
  },
}))

vi.mock('../../../pi/managementEventStore', () => ({
  useManagementEvents: () => ({ resourceRevisions: {} }),
}))

describe('PiResourceManagement', () => {
  beforeEach(() => {
    registryMock.mockReset().mockResolvedValue({
      extensions: [],
      tools: [{ name: 'mock-tool', description: 'a mock tool' }],
      activeTools: ['mock-tool'],
      commands: [{ name: 'reload', description: 'reload resources' }],
      eventHandlers: ['message_end'],
    })
    promptsMock.mockReset().mockResolvedValue([
      { name: 'code-review', description: 'Review this change', argumentHint: '<files>', content: '...', sourceInfo: { source: 'pi-extension' }, filePath: '/tmp/review.md' },
    ])
    skillsMock.mockReset().mockResolvedValue([
      { name: 'debug', description: 'Debug a failing test', filePath: '/tmp/debug.md', baseDir: '/tmp', sourceInfo: { source: 'pi-extension' }, disableModelInvocation: false },
    ])
    agentsFilesMock.mockReset().mockResolvedValue([
      { path: 'AGENTS.md', content: '# rules\none rule' },
    ])
    reloadMock.mockReset().mockResolvedValue(undefined)
  })

  it('shows the native registry and loaded prompt templates', async () => {
    render(<PiResourceManagement sessionId="session-1" workspacePath="E:\\workspace" />)

    // 各资源区块标题（默认折叠，内容需展开后可见）
    expect(await screen.findByText('pi.tools')).toBeInTheDocument()
    expect(screen.getByText('pi.commands')).toBeInTheDocument()
    expect(screen.getByText('pi.eventHandlers')).toBeInTheDocument()
    expect(screen.getByText('pi.prompts')).toBeInTheDocument()
    expect(screen.getByText('pi.agentsFiles')).toBeInTheDocument()
    expect(screen.getByText('pi.skills')).toBeInTheDocument()

    // 展开 tools 与 prompts 区块验证内容
    fireEvent.click(screen.getByText('pi.tools'))
    expect(await screen.findByText('mock-tool')).toBeInTheDocument()
    fireEvent.click(screen.getByText('pi.prompts'))
    expect(await screen.findByText('code-review <files>')).toBeInTheDocument()
    expect(screen.getByText(/Review this change/)).toBeInTheDocument()
    expect(screen.getByText(/\/tmp\/review\.md/)).toBeInTheDocument()
    // Skills 元数据：名称 + 描述 + 来源文件
    fireEvent.click(screen.getByText('pi.skills'))
    expect(await screen.findByText('debug')).toBeInTheDocument()
    expect(screen.getByText(/Debug a failing test/)).toBeInTheDocument()
    expect(screen.getByText(/\/tmp\/debug\.md/)).toBeInTheDocument()
    // AGENTS/CLAUDE 上下文文件
    fireEvent.click(screen.getByText('pi.agentsFiles'))
    expect(await screen.findByText('AGENTS.md')).toBeInTheDocument()
  })

  it('reloads resources through the native command', async () => {
    render(<PiResourceManagement sessionId="session-1" workspacePath="E:\\workspace" />)
    await screen.findByText('pi.tools')

    fireEvent.click(screen.getByRole('button', { name: 'common:reload' }))

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledWith('session-1')
    })
  })

  it('checks whether an extension event type has a registered handler', async () => {
    render(<PiResourceManagement sessionId="session-1" workspacePath="E:\\workspace" />)
    await screen.findByText('pi.eventHandlers')
    fireEvent.click(screen.getByText('pi.eventHandlers'))
    await screen.findByText('message_end')

    const input = screen.getByPlaceholderText('pi.eventTypePlaceholder')
    fireEvent.change(input, { target: { value: 'message_end' } })
    fireEvent.click(screen.getByRole('button', { name: 'pi.checkHandler' }))

    await waitFor(() => {
      expect(screen.getByText('pi.handlerRegistered')).toBeInTheDocument()
    })
  })
})
