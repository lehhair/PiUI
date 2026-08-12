import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeProps,
} from '@xyflow/react'
import { Bot, ChevronDown, ChevronUp, FileText, Focus, GitBranch, Maximize2, Minus, Plus, Search, UserRound, Wrench } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import { IconButton } from './ui/IconButton'
import {
  type SessionGraphNode,
  type SessionTreeGraph,
  type SessionTreeNodeData,
} from './sessionTreeGraph'

interface SessionTreeCanvasProps {
  sessionId: string
  graph: SessionTreeGraph
  selectedEntryId: string | null
  pendingEntryId: string | null
  loading: boolean
  error: string | null
  onSelectEntry: (entryId: string) => void
}

function roleLabel(data: SessionTreeNodeData, t: (key: string) => string): string {
  if (data.role === 'user') return t('sessionTree.roles.user')
  if (data.role === 'assistant') return t('sessionTree.roles.assistant')
  if (data.role === 'toolResult') return t('sessionTree.roles.tool')
  return t(`sessionTree.entryTypes.${data.type}`)
}

/** 角色 → 图标与芯片配色（图标上色代替整条左边框，视觉更轻） */
function roleVisual(data: SessionTreeNodeData) {
  if (data.role === 'user') return { Icon: UserRound, chip: 'bg-accent-main-100/12 text-accent-main-100' }
  if (data.role === 'assistant') return { Icon: Bot, chip: 'bg-success-100/12 text-success-100' }
  if (data.type === 'branch_summary') return { Icon: GitBranch, chip: 'bg-info-100/12 text-info-100' }
  if (data.type === 'compaction') return { Icon: FileText, chip: 'bg-bg-300/50 text-text-400' }
  return { Icon: Wrench, chip: 'bg-warning-100/12 text-warning-100' }
}

function nodeStateClass(data: SessionTreeNodeData, selected: boolean): string {
  if (data.currentLeaf) return 'border-accent-main-100 shadow-[0_0_0_1px_hsl(var(--accent-main-100)/0.45)]'
  if (selected) return 'border-text-200 shadow-[0_0_0_1px_hsl(var(--text-200)/0.4)]'
  if (data.activePath) return 'border-accent-main-100/40'
  return 'border-border-200/70 hover:border-border-300'
}

const handleClass = '!h-2 !w-2 !opacity-0 !pointer-events-none'

const SessionEntryNode = memo(function SessionEntryNode({ data, selected }: NodeProps<SessionGraphNode>) {
  const { t } = useTranslation('components')
  const { Icon, chip } = roleVisual(data)
  const stateClass = nodeStateClass(data, Boolean(selected))

  if (data.compact) {
    return (
      <div className={`relative flex h-full w-[240px] cursor-pointer items-center gap-2 overflow-hidden rounded-lg border bg-bg-100 px-2.5 transition-colors ${stateClass}`} title={data.preview}>
        <Handle type="target" position={Position.Top} className={handleClass} />
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${chip}`} aria-hidden="true"><Icon size={12} /></span>
        <span className="shrink-0 text-[length:var(--fs-xs)] font-medium text-text-300">{data.label || roleLabel(data, t)}</span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--fs-xs)] text-text-500">{data.preview}</span>
        {data.currentLeaf ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-main-100" aria-label={t('sessionTree.currentShort')} /> : null}
        <Handle type="source" position={Position.Bottom} className={handleClass} />
      </div>
    )
  }

  return (
    <div
      className={`relative h-full w-[240px] cursor-pointer overflow-hidden rounded-lg border bg-bg-100 transition-colors ${stateClass}`}
      title={data.preview}
    >
      <Handle type="target" position={Position.Top} className={handleClass} />
      <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-2">
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${chip}`} aria-hidden="true"><Icon size={12} /></span>
        <span className="min-w-0 truncate text-[length:var(--fs-xs)] font-medium text-text-400">
          {data.label || roleLabel(data, t)}
        </span>
        {data.currentLeaf ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[length:var(--fs-xs)] font-medium text-accent-main-100">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-main-100" aria-hidden="true" />
            {t('sessionTree.currentShort')}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-1 break-words px-2.5 pt-1 text-[length:var(--fs-sm)] leading-snug text-text-100">
        {data.preview}
      </p>
      <div className="flex min-h-5 items-center gap-2.5 px-2.5 pb-1.5 pt-1 text-[length:var(--fs-xs)] text-text-500">
        {data.toolCount > 0 ? (
          <span className={`inline-flex items-center gap-1 tabular-nums ${data.hasToolError ? 'text-danger-100' : 'text-text-500'}`} title={t('sessionTree.toolCount', { count: data.toolCount })}>
            <Wrench size={10} aria-hidden="true" />{data.toolCount}
          </span>
        ) : null}
        {data.branchCount > 1 ? (
          <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title={t('sessionTree.branches', { count: data.branchCount })}>
            <GitBranch size={10} aria-hidden="true" />{data.branchCount}
          </span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} className={handleClass} />
    </div>
  )
})

const nodeTypes = { sessionEntry: SessionEntryNode }

function CanvasContent({
  graph,
  selectedEntryId,
  pendingEntryId,
  loading,
  error,
  onSelectEntry,
}: Omit<SessionTreeCanvasProps, 'sessionId'>) {
  const { t } = useTranslation('components')
  const [query, setQuery] = useState('')
  // 当前定位到的匹配序号（-1 = 尚未定位）；query 变化时重置
  const [matchIndex, setMatchIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const [viewportRevision, setViewportRevision] = useState(0)
  const { fitView, zoomIn, zoomOut } = useReactFlow<SessionGraphNode>()
  const focusedLeafRef = useRef<string | null>(null)
  const fittedEmptyTreeRef = useRef(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const nodes = useMemo(() => graph.nodes.map(node => ({
    ...node,
    selected: node.id === selectedEntryId,
    ariaLabel: `${node.data.label || roleLabel(node.data, t)}: ${node.data.preview}`,
    className: normalizedQuery && !`${node.data.label ?? ''} ${node.data.preview}`.toLocaleLowerCase().includes(normalizedQuery)
      ? 'opacity-25'
      : node.id === pendingEntryId ? 'animate-pulse' : undefined,
  })), [graph.nodes, normalizedQuery, pendingEntryId, selectedEntryId, t])
  const matchedNodes = useMemo(() => normalizedQuery
    ? nodes.filter(node => `${node.data.label ?? ''} ${node.data.preview}`.toLocaleLowerCase().includes(normalizedQuery))
    : nodes,
  [nodes, normalizedQuery])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box && box.width > 0 && box.height > 0) setViewportRevision(value => value + 1)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const focusCurrent = useCallback(() => {
    const current = nodes.find(node => node.data.currentLeaf)
    if (!current) return
    void fitView({ nodes: [current], padding: 1, minZoom: 0.9, maxZoom: 0.9, duration: 250 })
    onSelectEntry(current.id)
  }, [fitView, nodes, onSelectEntry])

  // 上一个/下一个匹配跳转（循环）：fitView 定位 + 选中该节点
  const jumpToMatch = useCallback(
    (delta: 1 | -1) => {
      if (matchedNodes.length === 0) return
      const next = (matchIndex + delta + matchedNodes.length) % matchedNodes.length
      setMatchIndex(next)
      const target = matchedNodes[next]
      if (target) {
        void fitView({ nodes: [target], padding: 1, minZoom: 0.9, maxZoom: 0.9, duration: 200 })
        onSelectEntry(target.id)
      }
    },
    [fitView, matchedNodes, matchIndex, onSelectEntry],
  )

  useEffect(() => {
    if (nodes.length === 0 || viewportRevision === 0) return
    const frame = requestAnimationFrame(() => {
      const current = nodes.find(node => node.data.currentLeaf)
      if (current) {
        if (normalizedQuery || (selectedEntryId && selectedEntryId !== current.id)) return
        const focusKey = `${current.id}:${viewportRevision}`
        if (focusedLeafRef.current === focusKey) return
        void fitView({ nodes: [current], padding: 1, minZoom: 0.9, maxZoom: 0.9 }).then(applied => {
          if (applied) focusedLeafRef.current = focusKey
        })
      } else if (!fittedEmptyTreeRef.current) {
        fittedEmptyTreeRef.current = true
        void fitView({ padding: 0.2, minZoom: 0.35, maxZoom: 1.2 })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, nodes, normalizedQuery, selectedEntryId, viewportRevision])

  useEffect(() => {
    if (!normalizedQuery || viewportRevision === 0 || !selectedEntryId) return
    const selected = matchedNodes.find(node => node.id === selectedEntryId)
    if (selected) void fitView({ nodes: [selected], padding: 1, minZoom: 0.9, maxZoom: 0.9 })
  }, [fitView, matchedNodes, normalizedQuery, selectedEntryId, viewportRevision])

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-100">
      {/* 通栏工具条：与文件面板头部同款（h-10、内嵌图标搜索框、幽灵按钮、inset 细线） */}
      <div className="relative flex h-10 shrink-0 items-center gap-2 px-3">
        <div className="group relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-400 transition-colors group-focus-within:text-accent-main-100" aria-hidden="true" />
          <input
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setMatchIndex(-1)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setQuery('')
                setMatchIndex(-1)
              }
              // Enter 下一个 / Shift+Enter 上一个（循环）
              if (event.key === 'Enter') {
                event.preventDefault()
                jumpToMatch(event.shiftKey ? -1 : 1)
              }
            }}
            aria-label={t('sessionTree.search')}
            placeholder={t('sessionTree.searchPlaceholder')}
            autoComplete="off"
            className="w-full rounded-lg border border-transparent bg-bg-200/40 py-1 pl-[30px] pr-[88px] text-[length:var(--fs-xs)] text-text-100 transition-all placeholder:text-text-400/70 hover:bg-bg-200/60 focus:border-border-200 focus:bg-bg-000 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-border-200 focus-visible:outline-none"
          />
          <span
            className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5"
            aria-live="polite"
          >
            <span className="min-w-[2.5rem] px-1 text-right tabular-nums text-[length:var(--fs-xs)] text-text-500">
              {normalizedQuery ? `${matchIndex + 1}/${matchedNodes.length}` : nodes.length}
            </span>
            <button
              type="button"
              aria-label={t('sessionTree.searchPrevious')}
              title={t('sessionTree.searchPrevious')}
              disabled={!normalizedQuery || matchedNodes.length === 0}
              onClick={() => jumpToMatch(-1)}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-text-400 transition-colors hover:bg-bg-200/50 hover:text-text-100 disabled:pointer-events-none disabled:opacity-35"
            >
              <ChevronUp size={13} />
            </button>
            <button
              type="button"
              aria-label={t('sessionTree.searchNext')}
              title={t('sessionTree.searchNext')}
              disabled={!normalizedQuery || matchedNodes.length === 0}
              onClick={() => jumpToMatch(1)}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-text-400 transition-colors hover:bg-bg-200/50 hover:text-text-100 disabled:pointer-events-none disabled:opacity-35"
            >
              <ChevronDown size={13} />
            </button>
          </span>
        </div>
        <button
          type="button"
          aria-label={t('sessionTree.focusCurrent')}
          title={t('sessionTree.focusCurrent')}
          onClick={focusCurrent}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-400 transition-colors hover:bg-bg-200/50 hover:text-text-100"
        >
          <Focus size={14} />
        </button>
        <div className="pointer-events-none absolute inset-x-3 bottom-0 h-px bg-border-200/30" />
      </div>

      <div className="relative min-h-0 flex-1">
        <ReactFlow<SessionGraphNode>
          nodes={nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => onSelectEntry(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnPinch
          zoomOnScroll
          minZoom={0.15}
          maxZoom={2}
          fitView={false}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          className="session-tree-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1.4} color="hsl(var(--border-200) / 0.65)" />
        </ReactFlow>

        <div className="absolute bottom-2 left-2 z-10 flex items-center rounded-md border border-border-200 bg-bg-100/95 p-0.5 shadow-sm">
          <IconButton aria-label={t('sessionTree.zoomOut')} title={t('sessionTree.zoomOut')} size="sm" onClick={() => void zoomOut({ duration: 150 })}>
            <Minus size={14} />
          </IconButton>
          <IconButton aria-label={t('sessionTree.zoomIn')} title={t('sessionTree.zoomIn')} size="sm" onClick={() => void zoomIn({ duration: 150 })}>
            <Plus size={14} />
          </IconButton>
          <span className="mx-0.5 h-4 w-px bg-border-200" aria-hidden="true" />
          <IconButton aria-label={t('sessionTree.fitView')} title={t('sessionTree.fitView')} size="sm" onClick={() => void fitView({ padding: 0.2, minZoom: 0.25, maxZoom: 1.2, duration: 200 })}>
            <Maximize2 size={14} />
          </IconButton>
        </div>

        {loading && nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[length:var(--fs-sm)] text-text-400" role="status">
            {t('sessionTree.loading')}
          </div>
        ) : null}
        {!loading && nodes.length === 0 && !error ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[length:var(--fs-sm)] text-text-400">
            {t('sessionTree.empty')}
          </div>
        ) : null}
        {error ? (
          <div className="absolute bottom-2 left-2 right-2 rounded-md border border-danger-100/30 bg-bg-100 px-3 py-2 text-[length:var(--fs-xs)] text-danger-100" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const SessionTreeCanvas = memo(function SessionTreeCanvas(props: SessionTreeCanvasProps) {
  return (
    <ReactFlowProvider key={props.sessionId}>
      <CanvasContent {...props} />
    </ReactFlowProvider>
  )
})
