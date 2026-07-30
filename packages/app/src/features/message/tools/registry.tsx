import type { ReactNode } from 'react'
import type { ToolResultMessage } from '@earendil-works/pi-ai'
import type { PiToolExecution } from '../../../pi/domain/index.js'
import type { ToolConfig, ToolRegistry, ExtractedToolData, DiagnosticInfo } from './types'
import { BashRenderer, QuestionRenderer } from './renderers'
import {
  FileReadIcon,
  FileWriteIcon,
  TerminalIcon,
  SearchIcon,
  GlobeIcon,
  BrainIcon,
  ChecklistIcon,
  QuestionIcon,
  TaskIcon,
  WrenchIcon,
} from './icons'
import { detectLanguage } from '../../../utils/languageUtils'

// ============================================
// Tool Matchers (复用的匹配函数)
// ============================================

const includes =
  (...keywords: string[]) =>
  (name: string) => {
    const lower = name.toLowerCase()
    return keywords.some(k => lower.includes(k))
  }

const exact =
  (...names: string[]) =>
  (name: string) => {
    const lower = name.toLowerCase()
    return names.some(n => lower === n)
  }

interface MetadataFileEntry {
  filePath?: string
  file?: string
  diff?: string
  patch?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
}

interface MetadataDiagnosticEntry {
  severity?: number
  message?: string
  range?: {
    start?: {
      line?: number
      character?: number
    }
  }
}

// ============================================
// Default Data Extractor
// ============================================

function resultText(result: ToolResultMessage): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

export function defaultExtractData(execution: PiToolExecution): ExtractedToolData {
  const { call, result: toolResult } = execution
  const inputObj = call.arguments as Record<string, unknown> | undefined
  const metadata = toolResult?.details && typeof toolResult.details === 'object' && !Array.isArray(toolResult.details)
    ? toolResult.details as Record<string, unknown>
    : undefined
  const nativeDetails = metadata?.nativeDetails && typeof metadata.nativeDetails === 'object'
    ? metadata.nativeDetails as Record<string, unknown>
    : undefined
  const normalized = metadata?.normalized && typeof metadata.normalized === 'object'
    ? metadata.normalized as Record<string, unknown>
    : undefined
  const output = toolResult ? resultText(toolResult) : undefined

  const result: ExtractedToolData = {}

  // Native inline image blocks (pi tool results carry ImageContent inline)
  if (toolResult) {
    const images = toolResult.content.flatMap(block =>
      block.type === 'image'
        ? [{ url: `data:${block.mimeType};base64,${block.data}`, mimeType: block.mimeType }]
        : [],
    )
    if (images.length > 0) result.images = images
  }

  // Input
  if (inputObj && Object.keys(inputObj).length > 0) {
    result.input = JSON.stringify(inputObj, null, 2)
    result.inputLang = 'json'
  }

  // Error
  if (toolResult?.isError) {
    result.error = output || 'Tool execution failed'
  }

  // FilePath
  if (metadata && typeof metadata.filepath === 'string') {
    result.filePath = metadata.filepath
  }
  if (!result.filePath && inputObj?.filePath) {
    result.filePath = String(inputObj.filePath)
  }
  if (!result.filePath && typeof inputObj?.path === 'string') result.filePath = inputObj.path

  // Exit code
  if (metadata && typeof metadata.exit === 'number') {
    result.exitCode = metadata.exit
  }
  if (result.exitCode === undefined && typeof normalized?.exitCode === 'number') result.exitCode = normalized.exitCode
  const cwd = normalized?.cwd ?? metadata?.cwd ?? nativeDetails?.cwd
  if (typeof cwd === 'string') result.cwd = cwd

  // Diff / Files (from metadata)
  if (metadata) {
    if (Array.isArray(metadata.files) && metadata.files.length > 0) {
      result.files = (metadata.files as MetadataFileEntry[]).map(file => ({
        filePath: file.filePath || file.file || 'unknown',
        diff: file.diff,
        patch: file.patch,
        before: file.before,
        after: file.after,
        additions: file.additions,
        deletions: file.deletions,
      }))
    } else if (typeof metadata.diff === 'string') {
      // 优先使用 unified diff
      result.diff = metadata.diff
      // 从 filediff 获取统计
      if (metadata.filediff && typeof metadata.filediff === 'object') {
        const fd = metadata.filediff as { additions?: number; deletions?: number }
        if (fd.additions !== undefined || fd.deletions !== undefined) {
          result.diffStats = {
            additions: fd.additions || 0,
            deletions: fd.deletions || 0,
          }
        }
      }
    } else if (metadata.filediff && typeof metadata.filediff === 'object') {
      const fd = metadata.filediff as {
        patch?: string
        before?: string
        after?: string
        additions?: number
        deletions?: number
      }
      // 上游 v1.4.0+ metadata.filediff 用 patch 格式
      if (fd.patch) {
        result.diff = fd.patch
      } else if (fd.before !== undefined && fd.after !== undefined) {
        result.diff = { before: fd.before, after: fd.after }
      }
      if (fd.additions !== undefined || fd.deletions !== undefined) {
        result.diffStats = {
          additions: fd.additions || 0,
          deletions: fd.deletions || 0,
        }
      }
    }

    // 提取 diagnostics
    if (metadata.diagnostics && typeof metadata.diagnostics === 'object') {
      const diagMap = metadata.diagnostics as Record<string, MetadataDiagnosticEntry[]>
      const diagnostics: DiagnosticInfo[] = []

      for (const [file, items] of Object.entries(diagMap)) {
        if (!Array.isArray(items)) continue
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          // severity: 1=error, 2=warning, 3=info, 4=hint
          const severityMap: Record<number, DiagnosticInfo['severity']> = {
            1: 'error',
            2: 'warning',
            3: 'info',
            4: 'hint',
          }
          diagnostics.push({
            file: file.split(/[/\\]/).pop() || file,
            severity: typeof item.severity === 'number' ? (severityMap[item.severity] ?? 'info') : 'info',
            message: item.message || '',
            line: item.range?.start?.line ?? 0,
            column: item.range?.start?.character ?? 0,
          })
        }
      }

      // 只保留 error 和 warning
      const filtered = diagnostics.filter(d => d.severity === 'error' || d.severity === 'warning')
      if (filtered.length > 0) {
        result.diagnostics = filtered
      }
    }
  }

  const patch = normalized?.patch ?? nativeDetails?.patch ?? nativeDetails?.diff
  if (!result.diff && typeof patch === 'string') result.diff = patch
  const truncation = nativeDetails?.truncation as Record<string, unknown> | undefined
  const limits = [nativeDetails?.matchLimitReached, nativeDetails?.resultLimitReached, nativeDetails?.entryLimitReached]
    .filter(value => typeof value === 'number')
  if (truncation?.truncated === true || limits.length > 0) {
    const shown = typeof truncation?.outputLines === 'number' ? `${truncation.outputLines} lines shown` : 'Output truncated'
    const fullPath = typeof nativeDetails?.fullOutputPath === 'string' ? ` · Full output: ${nativeDetails.fullOutputPath}` : ''
    result.notice = `${shown}${fullPath}`
  }
  if (Array.isArray(metadata?.images)) {
    result.images = metadata.images.flatMap(image => {
      if (!image || typeof image !== 'object') return []
      const value = image as Record<string, unknown>
      return typeof value.url === 'string' && typeof value.mimeType === 'string'
        ? [{ url: value.url, mimeType: value.mimeType, requiresAuth: value.requiresAuth === true }]
        : []
    })
  }

  // Output language from filePath
  if (result.filePath) {
    result.outputLang = detectLanguage(result.filePath)
  }

  // Output: 分运行状态取不同的字段
  if (!result.files && !result.diff && output && !toolResult?.isError) {
    result.output = output

    // 推断语言
    if (!result.outputLang && result.output) {
      const trimmed = result.output.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        result.outputLang = 'json'
      }
    }
  }

  return result
}

// ============================================
// Tool-Specific Data Extractors
// ============================================

function bashExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined
  const metadata = execution.result?.details && typeof execution.result.details === 'object' && !Array.isArray(execution.result.details)
    ? execution.result.details as Record<string, unknown>
    : undefined

  if (inputObj?.command) {
    base.input = String(inputObj.command)
    base.inputLang = 'bash'
  }

  const cwd = inputObj?.workdir ?? inputObj?.cwd ?? metadata?.workdir ?? metadata?.cwd
  if (typeof cwd === 'string' && cwd.trim()) {
    base.cwd = cwd.trim()
  }

  return base
}

function readExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)

  if (base.output) {
    const match = base.output.match(/<file[^>]*>([\s\S]*?)<\/file>/i)
    base.output = match ? match[1] : base.output
  }

  return base
}

function writeExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined

  // 从 input.content 构造 diff（和 editExtractData 一致）
  // 状态控制由渲染层（OutputBlock）统一处理，extractData 只做数据转换
  if (!base.files && !base.diff && inputObj?.content && typeof inputObj.content === 'string') {
    base.diff = {
      before: '',
      after: inputObj.content,
    }
  }

  return base
}

function editExtractData(execution: PiToolExecution): ExtractedToolData {
  const base = defaultExtractData(execution)
  const inputObj = execution.call.arguments as Record<string, unknown> | undefined

  // 如果 metadata 没有 diff，从 input 构造
  if (!base.files && !base.diff && inputObj?.oldString && inputObj?.newString) {
    base.diff = {
      before: String(inputObj.oldString),
      after: String(inputObj.newString),
    }
  }
  if (!base.files && !base.diff && Array.isArray(inputObj?.edits) && inputObj.edits.length === 1) {
    const edit = inputObj.edits[0] as Record<string, unknown>
    if (typeof edit.oldText === 'string' && typeof edit.newText === 'string') {
      base.diff = { before: edit.oldText, after: edit.newText }
    }
  }

  return base
}

// ============================================
// Tool Registry
// 按优先级排列，第一个匹配的配置生效
// ============================================

export const toolRegistry: ToolRegistry = [
  { match: exact('bash'), icon: <TerminalIcon />, extractData: bashExtractData, renderer: BashRenderer },
  { match: exact('read'), icon: <FileReadIcon />, extractData: readExtractData },
  { match: exact('write'), icon: <FileWriteIcon />, extractData: writeExtractData },
  { match: exact('edit'), icon: <FileWriteIcon />, extractData: editExtractData },
  { match: exact('grep', 'find', 'ls'), icon: <SearchIcon /> },
  // Bash / Terminal
  {
    match: (name: string) => includes('bash', 'cmd', 'terminal', 'shell')(name) || exact('sh')(name),
    icon: <TerminalIcon />,
    extractData: bashExtractData,
    renderer: BashRenderer,
  },

  // Todo (must be before write/read to avoid TodoWrite matching "write")
  {
    match: includes('todo'),
    icon: <ChecklistIcon />,
  },

  // Task (子 agent)
  {
    match: exact('task'),
    icon: <TaskIcon />,
  },

  // Read file
  {
    match: includes('read', 'cat'),
    icon: <FileReadIcon />,
    extractData: readExtractData,
  },

  // Write file
  {
    match: includes('write', 'save'),
    icon: <FileWriteIcon />,
    extractData: writeExtractData,
  },

  // Edit file
  {
    match: includes('edit', 'replace', 'patch'),
    icon: <FileWriteIcon />,
    extractData: editExtractData,
  },

  // Search
  {
    match: includes('search', 'find', 'grep', 'glob'),
    icon: <SearchIcon />,
  },

  // Web / Network
  {
    match: includes('web', 'fetch', 'http', 'browse', 'network', 'exa'),
    icon: <GlobeIcon />,
  },

  // Think / Reasoning
  {
    match: includes('think', 'reason', 'plan'),
    icon: <BrainIcon />,
  },

  // Question
  {
    match: includes('question', 'ask'),
    icon: <QuestionIcon />,
    renderer: QuestionRenderer,
  },
]

// ============================================
// Registry Helpers
// ============================================

/**
 * 获取工具配置
 */
export function getToolConfig(toolName: string): ToolConfig | undefined {
  return toolRegistry.find(config => config.match(toolName))
}

/**
 * 获取工具图标
 */
export function getToolIcon(toolName: string): ReactNode {
  const config = getToolConfig(toolName)
  return config?.icon ?? <WrenchIcon />
}

/**
 * 提取工具数据
 */
export function extractToolData(execution: PiToolExecution): ExtractedToolData {
  const config = getToolConfig(execution.call.name)
  if (config?.extractData) {
    return config.extractData(execution)
  }
  return defaultExtractData(execution)
}
