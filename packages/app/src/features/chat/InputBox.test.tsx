import { forwardRef, useImperativeHandle, type ForwardedRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InputBox } from './InputBox'
import type { Command } from '../slash-command'
import type { PiBranchPage } from '../../pi/domain'

let slashCommands: Command[] = []
let historyTexts: string[] = []
const completionsMock = vi.fn()

vi.mock('../../pi/transport/index.js', () => ({
  getPiCommandCompletions: (...args: unknown[]) => completionsMock(...args),
}))

function historyBranch(): PiBranchPage {
  return {
    items: historyTexts.map((text, index) => ({
      id: `user-${index}`,
      type: 'message',
      message: { role: 'user', content: text, timestamp: index },
    })),
  } as unknown as PiBranchPage
}

vi.mock('../attachment', () => ({
  AttachmentPreview: () => null,
}))

vi.mock('./chatViewport', () => ({
  useChatViewport: () => ({
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
  }),
  useChatViewportSelect: <S,>(selector: (value: unknown) => S) =>
    selector({
      presentation: { surfaceVariant: 'desktop', isCompact: false },
      interaction: { mode: 'pointer', touchCapable: false, sidebarBehavior: 'docked', rightPanelBehavior: 'docked', bottomPanelBehavior: 'docked', outlineInteraction: 'pointer', enableCollapsedInputDock: false },
    }),}))

vi.mock('../mention', () => ({
  MentionMenu: () => null,
  detectMentionTrigger: () => null,
  normalizePath: (value: string) => value,
  toFileUrl: (value: string) => value,
}))

vi.mock('../slash-command', () => ({
  SlashCommandMenu: forwardRef(
    (
      { isOpen, onSelect }: { isOpen: boolean; onSelect: (command: Command) => void },
      ref: ForwardedRef<{ moveUp: () => void; moveDown: () => void; selectCurrent: () => void }>,
    ) => {
      useImperativeHandle(
        ref,
        () => ({
          moveUp: () => {},
          moveDown: () => {},
          selectCurrent: () => {
            const command = slashCommands[0]
            if (command) onSelect(command)
          },
        }),
        [onSelect],
      )

      return isOpen ? (
        <div>
          {slashCommands.map(command => (
            <button key={command.name} type="button" onClick={() => onSelect(command)}>
              {command.name}
            </button>
          ))}
        </div>
      ) : null
    },
  ),
}))

vi.mock('./input/InputToolbar', () => ({
  InputToolbar: ({ onSend, canSend }: { onSend: () => void; canSend: boolean }) => (
    <button type="button" onClick={onSend} disabled={!canSend}>
      send
    </button>
  ),
}))

vi.mock('./input/InputFooter', () => ({
  InputFooter: () => null,
}))

vi.mock('./input/UndoStatus', () => ({
  UndoStatus: () => null,
}))

vi.mock('../../hooks', () => ({
  useIsMobile: () => false,
  usePresence: (show: boolean) => ({ shouldRender: show, ref: { current: null } }),
}))

vi.mock('../../pi/hooks/index.js', () => ({
  useFocusedSessionId: () => 'session-1',
  usePiBranchData: () => historyBranch(),
}))

vi.mock('../../store/keybindingStore', () => ({
  keybindingStore: {
    getKey: (action: string) => (action === 'sendMessage' ? 'Enter' : null),
  },
  matchesKeybinding: (event: KeyboardEvent, key: string) => key === 'Enter' && event.key === 'Enter',
}))

describe('InputBox slash command selection', () => {
  beforeEach(() => {
    slashCommands = []
    historyTexts = []
    completionsMock.mockReset()
  })

  it('executes frontend commands immediately on selection', async () => {
    slashCommands = [{ name: 'compact', description: 'Compact session', source: 'frontend' }]
    const onCommand = vi.fn()

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'compact' }))

    await waitFor(() => {
      expect(onCommand).toHaveBeenCalledWith('/compact')
      expect(textarea.value).toBe('')
    })
  })

  it('keeps api commands on attachment insertion path', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    const onCommand = vi.fn()

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'review' }))

    await waitFor(() => {
      expect(onCommand).not.toHaveBeenCalled()
      expect(textarea.value).toBe('/review ')
    })
  })

  it('auto-opens completions after selecting a command and applies on Enter', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([
      { value: 'workspace-write', label: 'workspace-write' },
      { value: 'read-only', label: 'read-only' },
    ])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'permission' }))

    // 选中命令后无需 Tab，自动弹出全部候选
    await waitFor(() => {
      expect(completionsMock).toHaveBeenCalledWith('s1', 'permission', '')
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })

    // Enter 应用选中的补全
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => expect(textarea.value).toBe('/permission workspace-write'))
  })

  it('filters completions live as the user types the argument prefix', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([
      { value: 'workspace-write', label: 'workspace-write' },
      { value: 'read-only', label: 'read-only' },
      { value: 'danger-full-access', label: 'danger-full-access' },
    ])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'permission' }))

    // 自动弹出全部候选
    await waitFor(() => {
      expect(completionsMock).toHaveBeenCalledWith('s1', 'permission', '')
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })

    // 输入前缀 w：防抖后按新前缀重新请求
    completionsMock.mockResolvedValue([{ value: 'workspace-write', label: 'workspace-write' }])
    fireEvent.change(textarea, { target: { value: '/permission w' } })
    await waitFor(() => {
      expect(completionsMock).toHaveBeenCalledWith('s1', 'permission', 'w')
    })
  })

  it('applies argument completion on Enter after deleting the trailing space (no re-insert / duplicate attachment)', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([
      { value: 'workspace-write', label: 'workspace-write' },
      { value: 'read-only', label: 'read-only' },
    ])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // 从 slash 菜单选中 permission → 文本 "/permission " + 命令附件 + 自动弹出候选
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'permission' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })

    // 删掉参数区空格 → "/permission"：slash 菜单不应重新打开（命令已确定），
    // 参数补全（attachment 路径）保持有效
    fireEvent.change(textarea, { target: { value: '/permission', selectionStart: 11 } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })

    // 回车：应直接应用参数补全，而不是被 slash 菜单抢走重新插入命令
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => {
      expect(textarea.value).toBe('/permission workspace-write')
    })
  })

  it('replaces the command attachment when the same slash command is selected twice', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([{ value: 'workspace-write', label: 'workspace-write' }])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'permission' }))
    // 再次通过 slash 菜单选择同一命令：附件应被替换而不是追加
    fireEvent.change(textarea, { target: { value: '/perm', selectionStart: 5 } })
    fireEvent.click(screen.getByRole('button', { name: 'permission' }))

    // 最终文本只有一份命令文本，且补全只应用一次（无重复附件导致的异常）
    await waitFor(() => {
      expect(textarea.value).toBe('/permission ')
    })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await waitFor(() => {
      expect(textarea.value).toBe('/permission workspace-write')
    })
  })

  it('re-schedules argument completions after IME composition ends', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([{ value: 'workspace-write', label: 'workspace-write' }])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // 中文输入法：组合期间输入 /permission w（change 被 isComposing 跳过）
    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, { target: { value: '/permission ', selectionStart: 12 } })
    fireEvent.change(textarea, { target: { value: '/permission w', selectionStart: 13 } })
    expect(completionsMock).not.toHaveBeenCalled()

    // 组合结束：应补发一次调度，参数区自动弹出补全（无需下一次输入/删除）
    fireEvent.compositionEnd(textarea)
    await waitFor(() => {
      expect(completionsMock).toHaveBeenCalledWith('s1', 'permission', 'w')
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })
  })

  it('keeps Tab as a fallback trigger for argument completions', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([{ value: 'workspace-write', label: 'workspace-write' }])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // 手输命令（无 attachment 路径）后按 Tab 触发
    fireEvent.change(textarea, { target: { value: '/permission w' } })
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.keyDown(textarea, { key: 'Tab' })

    await waitFor(() => {
      expect(completionsMock).toHaveBeenCalledWith('s1', 'permission', 'w')
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })
  })

  it('auto-opens completions when typing the command by hand (no slash menu selection)', async () => {
    slashCommands = [{ name: 'permission', description: 'Permission presets', source: 'api' }]
    completionsMock.mockResolvedValue([
      { value: 'workspace-write', label: 'workspace-write' },
      { value: 'read-only', label: 'read-only' },
      { value: 'danger-full-access', label: 'danger-full-access' },
    ])

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={vi.fn()} sessionId="s1" />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // 手输 /permission + 空格 + w，每次 change 带真实光标位置（用户场景：
    // 不走 slash 菜单选中，参数区应自动弹出补全）
    fireEvent.change(textarea, { target: { value: '/permission', selectionStart: 11 } })
    fireEvent.change(textarea, { target: { value: '/permission ', selectionStart: 12 } })
    fireEvent.change(textarea, { target: { value: '/permission w', selectionStart: 13 } })

    await waitFor(() => {
      expect(completionsMock).toHaveBeenCalledWith('s1', 'permission', 'w')
      expect(screen.getByRole('button', { name: 'workspace-write' })).toBeTruthy()
    })
  })

  it('keeps the draft when sending fails', async () => {
    const onSend = vi.fn().mockResolvedValue(false)

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('hello world', [], { agent: undefined, variant: undefined })
    })

    expect(textarea.value).toBe('hello world')
  })

  it('appends async recovery text once without overwriting a newer draft', async () => {
    const onSend = vi.fn(() => new Promise<boolean>(() => {}))
    const { rerender } = render(<InputBox paneId="pane-test" onSend={onSend} restoreMode="append" />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'new draft' } })

    rerender(
      <InputBox
        paneId="pane-test"
        onSend={onSend}
        restoreMode="append"
        revertedText="failed prompt"
      />,
    )
    await waitFor(() => expect(textarea.value).toBe('new draft\n\nfailed prompt'))

    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    await act(async () => {})
    expect(textarea.value).toBe('new draft\n\nfailed prompt')
  })

  it('waits for send acknowledgement before clearing the draft', async () => {
    let resolveSend: ((value: boolean) => void) | null = null
    const onSend = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'pending send' } })
    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    expect(textarea.value).toBe('pending send')

    await act(async () => {
      resolveSend?.(true)
    })

    await waitFor(() => {
      expect(textarea.value).toBe('')
    })
  })

  it('clears api slash command drafts immediately after keyboard submission', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    let resolveCommand: ((value: boolean) => void) | null = null
    const onCommand = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveCommand = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })

    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    expect(onCommand).toHaveBeenCalledWith('/review')
    expect(textarea.value).toBe('')
    expect(textarea).not.toBeDisabled()

    fireEvent.change(textarea, { target: { value: 'next prompt' } })
    expect(textarea.value).toBe('next prompt')

    await act(async () => {
      resolveCommand?.(true)
    })
  })

  it('restores api slash command drafts when command submission fails', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    let resolveCommand: ((value: boolean) => void) | null = null
    const onCommand = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveCommand = resolve
        }),
    )

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'review' }))

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })

    fireEvent.click(screen.getByRole('button', { name: 'send' }))
    expect(textarea.value).toBe('')

    await act(async () => {
      resolveCommand?.(false)
    })

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })
  })

  it('restores api slash command drafts when command submission fails synchronously', async () => {
    slashCommands = [{ name: 'review', description: 'Run review', source: 'api' }]
    const onCommand = vi.fn().mockReturnValue(false)

    render(<InputBox paneId="pane-test" onSend={vi.fn()} onCommand={onCommand} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/', selectionStart: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'review' }))

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })

    fireEvent.click(screen.getByRole('button', { name: 'send' }))

    await waitFor(() => {
      expect(textarea.value).toBe('/review ')
    })
  })

  it('does not send when Enter confirms IME composition', async () => {
    const onSend = vi.fn()

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '这是一个 test' } })

    fireEvent.compositionStart(textarea)
    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    fireEvent.keyDown(textarea, { key: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('这是一个 test', [], { agent: undefined, variant: undefined })
    })
  })

  it('does not send keydown events marked as IME composition', () => {
    const onSend = vi.fn()

    render(<InputBox paneId="pane-test" onSend={onSend} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '正在输入' } })
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps navigating multiline history entries with ArrowUp', async () => {
    historyTexts = ['first line\nsecond line', 'third line\nfourth line']

    render(<InputBox paneId="pane-test" onSend={vi.fn()} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    await waitFor(() => {
      expect(textarea.value).toBe('third line\nfourth line')
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(0)
    })

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    await waitFor(() => {
      expect(textarea.value).toBe('first line\nsecond line')
      expect(textarea.selectionStart).toBe(0)
      expect(textarea.selectionEnd).toBe(0)
    })
  })

  it('moves the caret to the end when navigating forward with ArrowDown', async () => {
    historyTexts = ['older line\nentry', 'newer line\nentry']

    render(<InputBox paneId="pane-test" onSend={vi.fn()} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(textarea.value).toBe('newer line\nentry')
    })

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(textarea.value).toBe('older line\nentry')
      expect(textarea.selectionStart).toBe(0)
    })

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })

    await waitFor(() => {
      expect(textarea.value).toBe('newer line\nentry')
      expect(textarea.selectionStart).toBe('newer line\nentry'.length)
      expect(textarea.selectionEnd).toBe('newer line\nentry'.length)
    })
  })
})
