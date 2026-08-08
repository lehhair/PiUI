// ============================================
// Pi TUI 内置斜杠命令清单
// ============================================

export type CommandSource = 'frontend' | 'builtin' | 'api'

export interface Command {
  name: string
  description?: string
  argumentHint?: string
  keybind?: string
  source: CommandSource
}

/**
 * Pi TUI 内置斜杠命令全集（与 pi-coding-agent 的 BUILTIN_SLASH_COMMANDS 对齐）。
 * PiUI 前端本地处理这些命令（见 PiChatPane.handleCommand），所以无论会话
 * registry 是否返回（打包后的 Bun exe 内联了 SDK，registry 的 commands 可能
 * 为空），斜杠菜单都必须展示它们——否则输入 / 时菜单为空。
 * 'frontend' 选中即立即执行（无参数命令）；'builtin' 走附件插入路径，方便
 * 继续输入参数（如 /bash ls -la）。
 */
export function getFrontendCommands(): Command[] {
  return [
    { name: 'new', description: 'Start a new session', source: 'frontend' },
    { name: 'compact', description: 'Manually compact the session context', source: 'frontend' },
    { name: 'model', description: 'Select model (opens selector UI)', argumentHint: '<provider/model>', source: 'frontend' },
    { name: 'settings', description: 'Open settings menu', source: 'frontend' },
    { name: 'hotkeys', description: 'Show all keyboard shortcuts', source: 'frontend' },
    { name: 'changelog', description: 'Show changelog entries', source: 'frontend' },
    { name: 'resume', description: 'Resume a different session', source: 'frontend' },
    { name: 'session', description: 'Show session info and stats', source: 'frontend' },
    { name: 'tree', description: 'Navigate session tree (switch branches)', source: 'frontend' },
    { name: 'clone', description: 'Duplicate the current session at the current position', source: 'frontend' },
    { name: 'copy', description: 'Copy last agent message to clipboard', source: 'frontend' },
    { name: 'fork', description: 'Create a new fork from a previous user message', source: 'frontend' },
    { name: 'trust', description: 'Save project trust decision for future sessions', source: 'frontend' },
    { name: 'login', description: 'Configure provider authentication', argumentHint: '<provider>', source: 'frontend' },
    { name: 'logout', description: 'Remove provider authentication', source: 'frontend' },
    { name: 'export', description: 'Export session (HTML default, or specify path: .html/.jsonl)', source: 'frontend' },
    { name: 'import', description: 'Import and resume a session from a JSONL file', source: 'frontend' },
    { name: 'scoped-models', description: 'Enable/disable models for Ctrl+P cycling', source: 'frontend' },
    { name: 'name', description: 'Set session display name', source: 'frontend' },
    { name: 'share', description: 'Share session as a secret GitHub gist', source: 'frontend' },
    { name: 'reload', description: 'Reload keybindings, extensions, skills, prompts, themes, and context files', source: 'frontend' },
    { name: 'quit', description: 'Quit Pi', source: 'frontend' },
    // PiUI 扩展：把 bash 也做成斜杠命令（pi TUI 里 ! 前缀的对应物）
    { name: 'bash', description: 'Run a one-shot bash command', argumentHint: '<command>', source: 'builtin' },
  ]
}
