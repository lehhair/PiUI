import dagre from '@dagrejs/dagre'
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { PiNativeJsonValueV1 } from '@piui/protocol'

export type NativeEntry = { [key: string]: PiNativeJsonValueV1 }
export type NativeTreeNode = NativeEntry & {
  entry: NativeEntry
  children: NativeTreeNode[]
  label?: string
  labelTimestamp?: string
}

export interface SessionTreeNodeData extends Record<string, unknown> {
  entryId: string
  type: string
  role?: string
  label?: string
  preview: string
  activePath: boolean
  currentLeaf: boolean
  branchCount: number
  compact: boolean
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
}

export type SessionGraphNode = Node<SessionTreeNodeData, 'sessionEntry'>

export interface SessionTreeGraph {
  nodes: SessionGraphNode[]
  edges: Edge[]
  nodeById: Map<string, NativeTreeNode>
}

const NODE_WIDTH = 200
const MESSAGE_HEIGHT = 48
const EVENT_HEIGHT = 40

function asRecord(value: PiNativeJsonValueV1 | undefined): NativeEntry {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textFromNative(value: PiNativeJsonValueV1 | undefined): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let text = ''
  for (const item of value) {
    const record = asRecord(item)
    if (record.type === 'text' && typeof record.text === 'string') text += record.text
  }
  return text
}

function normalizePreview(value: string): string {
  const normalized = value.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized
}

function shortenPath(path: string): string {
  return path
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read': {
      const path = shortenPath(String(args.path || args.file_path || ''))
      const offset = args.offset as number | undefined
      const limit = args.limit as number | undefined
      let display = path
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1
        const end = limit !== undefined ? start + limit - 1 : ''
        display += `:${start}${end ? `-${end}` : ''}`
      }
      return `[read: ${display}]`
    }
    case 'write': {
      const path = shortenPath(String(args.path || args.file_path || ''))
      return `[write: ${path}]`
    }
    case 'edit': {
      const path = shortenPath(String(args.path || args.file_path || ''))
      return `[edit: ${path}]`
    }
    case 'bash': {
      const rawCmd = String(args.command || '')
      const cmd = rawCmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50)
      return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`
    }
    case 'grep': {
      const pattern = String(args.pattern || '')
      const path = shortenPath(String(args.path || '.'))
      return `[grep: /${pattern}/ in ${path}]`
    }
    case 'find': {
      const pattern = String(args.pattern || '')
      const path = shortenPath(String(args.path || '.'))
      return `[find: ${pattern} in ${path}]`
    }
    case 'ls': {
      const path = shortenPath(String(args.path || '.'))
      return `[ls: ${path}]`
    }
    default: {
      const argsStr = JSON.stringify(args).slice(0, 40)
      return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? '...' : ''}]`
    }
  }
}

function extractToolCalls(entry: NativeEntry): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  if (entry.type !== 'message') return []
  const message = asRecord(entry.message)
  if (message.role !== 'assistant') return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  for (const block of content) {
    const record = asRecord(block)
    if (record.type === 'toolCall' && typeof record.id === 'string' && typeof record.name === 'string') {
      toolCalls.push({ id: record.id, name: record.name, args: asRecord(record.arguments) })
    }
  }
  return toolCalls
}

export function sessionTreeEntryPreview(entry: NativeEntry, typeLabel: (type: string) => string): string {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  if (type === 'message') {
    const message = asRecord(entry.message)
    const role = String(message.role ?? '')
    const text = normalizePreview(textFromNative(message.content))
    if (role === 'assistant') {
      if (text) return text
      if (message.stopReason === 'aborted') return typeLabel('assistant_aborted')
      if (typeof message.errorMessage === 'string' && message.errorMessage) return normalizePreview(message.errorMessage)
      return typeLabel('assistant_empty')
    }
    return text || role || typeLabel(type)
  }
  if (type === 'model_change') return `${String(entry.provider ?? '')}/${String(entry.modelId ?? '')}`
  if (type === 'thinking_level_change') return String(entry.thinkingLevel ?? typeLabel(type))
  if (type === 'compaction' || type === 'branch_summary') return normalizePreview(String(entry.summary ?? typeLabel(type)))
  if (type === 'custom_message') return normalizePreview(textFromNative(entry.content) || String(entry.customType ?? typeLabel(type)))
  if (type === 'custom') return String(entry.customType ?? typeLabel(type))
  if (type === 'label') return String(entry.label ?? typeLabel(type))
  if (type === 'session_info') return String(entry.name ?? typeLabel(type))
  return typeLabel(type)
}

export function findSessionTreeNode(tree: NativeTreeNode[], entryId: string | null): NativeTreeNode | undefined {
  if (!entryId) return undefined
  const stack = [...tree]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.entry.id === entryId) return node
    stack.push(...node.children)
  }
  return undefined
}

function isTuiVisibleEntry(entry: NativeEntry, currentLeafId: string | null): boolean {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const entryId = typeof entry.id === 'string' ? entry.id : null
  if (entryId === currentLeafId) {
    if (type === 'message') {
      const message = asRecord(entry.message)
      if (message.role === 'assistant') {
        const hasText = textFromNative(message.content).length > 0
        const isErrorOrAborted = typeof message.stopReason === 'string' &&
          message.stopReason !== 'stop' && message.stopReason !== 'toolUse'
        return hasText || isErrorOrAborted
      }
      return true
    }
    return type !== 'label' && type !== 'custom' && type !== 'model_change' &&
      type !== 'thinking_level_change' && type !== 'session_info' && type !== 'active_tools_change'
  }
  if (type === 'message') {
    const message = asRecord(entry.message)
    if (message.role === 'assistant') {
      const hasText = textFromNative(message.content).length > 0
      const isErrorOrAborted = typeof message.stopReason === 'string' &&
        message.stopReason !== 'stop' && message.stopReason !== 'toolUse'
      return hasText || isErrorOrAborted
    }
    return true
  }
  return type !== 'label' && type !== 'custom' && type !== 'model_change' &&
    type !== 'thinking_level_change' && type !== 'session_info' && type !== 'active_tools_change'
}

export function buildSessionTreeGraph(
  tree: NativeTreeNode[],
  leafId: string | null,
  typeLabel: (type: string) => string,
): SessionTreeGraph {
  const graph = new dagre.graphlib.Graph()
    .setGraph({ rankdir: 'TB', ranksep: 48, nodesep: 24, marginx: 24, marginy: 24 })
    .setDefaultEdgeLabel(() => ({}))
  const nodeById = new Map<string, NativeTreeNode>()
  const rawParentById = new Map<string, string | null>()
  const parentById = new Map<string, string | null>()
  const childCountById = new Map<string, number>()
  const orderedIds: string[] = []

  const indexRawTree = (node: NativeTreeNode, parentId: string | null) => {
    const entryId = typeof node.entry.id === 'string' ? node.entry.id : ''
    if (!entryId || rawParentById.has(entryId)) return
    rawParentById.set(entryId, parentId)
    for (const child of node.children) indexRawTree(child, entryId)
  }
  for (const root of tree) indexRawTree(root, null)

  let visualLeafId = leafId
  while (visualLeafId && !isTuiVisibleEntry(findSessionTreeNode(tree, visualLeafId)?.entry ?? {}, visualLeafId)) {
    visualLeafId = rawParentById.get(visualLeafId) ?? null
  }

  const visit = (node: NativeTreeNode, visibleParentId: string | null) => {
    const entryId = typeof node.entry.id === 'string' ? node.entry.id : ''
    if (!entryId) return
    let nextVisibleParentId = visibleParentId
    if (isTuiVisibleEntry(node.entry, visualLeafId) && !nodeById.has(entryId)) {
      nodeById.set(entryId, node)
      parentById.set(entryId, visibleParentId)
      orderedIds.push(entryId)
      const type = typeof node.entry.type === 'string' ? node.entry.type : 'unknown'
      const compact = type !== 'message' && type !== 'custom_message' && type !== 'branch_summary'
      graph.setNode(entryId, { width: NODE_WIDTH, height: compact ? EVENT_HEIGHT : MESSAGE_HEIGHT })
      if (visibleParentId) {
        graph.setEdge(visibleParentId, entryId)
        childCountById.set(visibleParentId, (childCountById.get(visibleParentId) ?? 0) + 1)
      }
      nextVisibleParentId = entryId
    }
    for (const child of node.children) visit(child, nextVisibleParentId)
  }
  for (const root of tree) visit(root, null)

  const activePath = new Set<string>()
  let cursor = visualLeafId
  while (cursor && !activePath.has(cursor)) {
    activePath.add(cursor)
    cursor = parentById.get(cursor) ?? null
  }

  dagre.layout(graph)

  const nodes: SessionGraphNode[] = orderedIds.map(entryId => {
    const source = nodeById.get(entryId)!
    const layout = graph.node(entryId)
    const type = typeof source.entry.type === 'string' ? source.entry.type : 'unknown'
    const message = asRecord(source.entry.message)
    const role = type === 'message' && typeof message.role === 'string' ? message.role : undefined
    const compact = type !== 'message' && type !== 'custom_message' && type !== 'branch_summary'
    const toolCalls = extractToolCalls(source.entry)
    const preview = sessionTreeEntryPreview(source.entry, typeLabel)
    const displayPreview = toolCalls.length > 0 && !preview.includes('[')
      ? `${toolCalls.map(tc => formatToolCall(tc.name, tc.args)).join(' ')} ${preview}`.trim()
      : preview
    return {
      id: entryId,
      type: 'sessionEntry',
      position: { x: layout.x - NODE_WIDTH / 2, y: layout.y - layout.height / 2 },
      data: {
        entryId,
        type,
        role,
        label: source.label,
        preview: displayPreview,
        activePath: activePath.has(entryId),
        currentLeaf: entryId === visualLeafId,
        branchCount: childCountById.get(entryId) ?? 0,
        compact,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      width: NODE_WIDTH,
      height: compact ? EVENT_HEIGHT : MESSAGE_HEIGHT,
      selectable: true,
      focusable: true,
      ariaRole: 'button',
    }
  })

  const edges: Edge[] = graph.edges().map(({ v, w }) => {
    const onActivePath = activePath.has(v) && activePath.has(w)
    const color = onActivePath ? 'hsl(var(--accent-main-100))' : 'hsl(var(--border-200) / 0.6)'
    return {
      id: `${v}->${w}`,
      source: v,
      target: w,
      type: 'smoothstep',
      style: { stroke: color, strokeWidth: onActivePath ? 2 : 1, opacity: 0.8 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
      zIndex: onActivePath ? 2 : 1,
    }
  })

  return { nodes, edges, nodeById }
}
