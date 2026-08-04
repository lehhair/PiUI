import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import type { JsonObject, JsonValue } from '@piui/protocol'

// Tree entries arrive as SDK SessionEntry/SessionTreeNode; the graph renders
// any entry shape (including future unknown types) so it reads fields
// duck-typed over JSON records.
export type NativeEntry = JsonObject
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
  toolCount: number
  hasToolError: boolean
  compact: boolean
}

export type SessionGraphNode = Node<SessionTreeNodeData, 'sessionEntry'>

export interface SessionTreeGraph {
  nodes: SessionGraphNode[]
  edges: Edge[]
  nodeById: Map<string, NativeTreeNode>
  detailEntriesById: Map<string, NativeEntry[]>
}

const NODE_WIDTH = 240
const MESSAGE_HEIGHT = 78
const EVENT_HEIGHT = 54

function asRecord(value: JsonValue | undefined): NativeEntry {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function textFromNative(value: JsonValue | undefined): string {
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

/**
 * 目标节点从根到自身的 id 路径（含目标）。跨分支导航时用它算
 * "旧分支上被裁掉的部分"：旧时间线 − 这条路径 = redo 的来源。
 */
export function findSessionTreePath(tree: NativeTreeNode[], entryId: string): string[] | null {
  const path: string[] = []
  const visit = (node: NativeTreeNode): boolean => {
    const id = typeof node.entry.id === 'string' ? node.entry.id : ''
    path.push(id)
    if (id === entryId) return true
    for (const child of node.children) {
      if (visit(child)) return true
    }
    path.pop()
    return false
  }
  for (const root of tree) {
    path.length = 0
    if (visit(root)) return path
  }
  return null
}

function entryTime(entry: NativeEntry): number {
  const value = entry.timestamp
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/**
 * 节点向下的"分支尾巴"：每步选时间最新的子节点直到叶子。
 * 导航到某个节点时被裁掉的就是这一段——redo 只恢复自己分支的后续，
 * 不做跨分支 redo。多叉时最新子分支就是该分支最近的活跃延续。
 */
export function findNewestDescendantEntries(node: NativeTreeNode): NativeEntry[] {
  const entries: NativeEntry[] = []
  let current = node
  while (current.children.length > 0) {
    let next = current.children[0]
    for (const child of current.children) {
      if (entryTime(child.entry) > entryTime(next.entry)) next = child
    }
    entries.push(next.entry)
    current = next
  }
  return entries
}

export function isTreeVisibleEntry(entry: NativeEntry, currentLeafId: string | null): boolean {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const entryId = typeof entry.id === 'string' ? entry.id : null
  if (entryId === currentLeafId) {
    if (type === 'message') {
      const message = asRecord(entry.message)
      if (message.role === 'toolResult') return false
      if (message.role === 'assistant') {
        const hasText = textFromNative(message.content).trim().length > 0
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
    if (message.role === 'toolResult') return false
    if (message.role === 'assistant') {
      const hasText = textFromNative(message.content).trim().length > 0
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
    .setGraph({ rankdir: 'TB', ranksep: 68, nodesep: 36, marginx: 40, marginy: 40 })
    .setDefaultEdgeLabel(() => ({}))
  const nodeById = new Map<string, NativeTreeNode>()
  const rawParentById = new Map<string, string | null>()
  const parentById = new Map<string, string | null>()
  const childCountById = new Map<string, number>()
  const detailEntriesById = new Map<string, NativeEntry[]>()
  const orderedIds: string[] = []

  const indexRawTree = (node: NativeTreeNode, parentId: string | null) => {
    const entryId = typeof node.entry.id === 'string' ? node.entry.id : ''
    if (!entryId || rawParentById.has(entryId)) return
    rawParentById.set(entryId, parentId)
    for (const child of node.children) indexRawTree(child, entryId)
  }
  for (const root of tree) indexRawTree(root, null)

  let visualLeafId = leafId
  while (visualLeafId && !isTreeVisibleEntry(findSessionTreeNode(tree, visualLeafId)?.entry ?? {}, visualLeafId)) {
    visualLeafId = rawParentById.get(visualLeafId) ?? null
  }

  const toolCallIds = (entry: NativeEntry) => {
    const message = asRecord(entry.message)
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
    return message.content.flatMap(item => {
      const block = asRecord(item)
      const id = typeof block.id === 'string' ? block.id : typeof block.toolCallId === 'string' ? block.toolCallId : ''
      return (block.type === 'toolCall' || block.type === 'tool_call' || block.type === 'toolUse') && id ? [id] : []
    })
  }

  const visit = (node: NativeTreeNode, visibleParentId: string | null, pendingDetails: NativeEntry[]) => {
    const entryId = typeof node.entry.id === 'string' ? node.entry.id : ''
    if (!entryId) return
    let nextVisibleParentId = visibleParentId
    let nextPendingDetails = pendingDetails
    if (isTreeVisibleEntry(node.entry, visualLeafId) && !nodeById.has(entryId)) {
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
      const role = asRecord(node.entry.message).role
      const details = role === 'assistant' ? [...pendingDetails, node.entry] : [node.entry]
      detailEntriesById.set(entryId, details)
      nextPendingDetails = role === 'assistant' && toolCallIds(node.entry).length > 0 ? [node.entry] : []
    } else {
      const message = asRecord(node.entry.message)
      if (node.entry.type === 'message' && (message.role === 'assistant' || message.role === 'toolResult')) {
        nextPendingDetails = [...pendingDetails, node.entry]
      }
    }
    if (entryId === leafId && nextVisibleParentId && nextPendingDetails.length > 0) {
      const currentDetails = detailEntriesById.get(nextVisibleParentId) ?? []
      const knownIds = new Set(currentDetails.map(detail => detail.id))
      detailEntriesById.set(nextVisibleParentId, [
        ...currentDetails,
        ...nextPendingDetails.filter(detail => !knownIds.has(detail.id)),
      ])
      nextPendingDetails = []
    }
    for (const child of node.children) visit(child, nextVisibleParentId, nextPendingDetails)
  }
  for (const root of tree) visit(root, null, [])

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
    const details = detailEntriesById.get(entryId) ?? [source.entry]
    const calls = details.flatMap(toolCallIds)
    const hasToolError = details.some(detail => {
      const detailMessage = asRecord(detail.message)
      return detailMessage.role === 'toolResult' && detailMessage.isError === true
    })
    return {
      id: entryId,
      type: 'sessionEntry',
      position: { x: layout.x - NODE_WIDTH / 2, y: layout.y - layout.height / 2 },
      data: {
        entryId,
        type,
        role,
        label: source.label,
        preview: sessionTreeEntryPreview(source.entry, typeLabel),
        activePath: activePath.has(entryId),
        currentLeaf: entryId === visualLeafId,
        branchCount: childCountById.get(entryId) ?? 0,
        toolCount: calls.length,
        hasToolError,
        compact,
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
    // 贝塞尔曲线 + 无箭头：树形方向由布局（自上而下）表达，
    // 箭头和折线只会增加噪点
    return {
      id: `${v}->${w}`,
      source: v,
      target: w,
      type: 'default',
      style: {
        stroke: onActivePath ? 'hsl(var(--accent-main-100) / 0.75)' : 'hsl(var(--border-200) / 0.55)',
        strokeWidth: onActivePath ? 2 : 1.5,
      },
      zIndex: onActivePath ? 2 : 1,
    }
  })

  return { nodes, edges, nodeById, detailEntriesById }
}
