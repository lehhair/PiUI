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
import { Bot, FileText, Focus, GitBranch, Maximize2, Minus, Plus, Search, UserRound, Wrench } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import { IconButton } from './ui/IconButton'
import {
  buildSessionTreeGraph,
  type NativeTreeNode,
  type SessionGraphNode,
  type SessionTreeNodeData,
} from './sessionTreeGraph'

interface SessionTreeCanvasProps {
  sessionId: string
  tree: NativeTreeNode[]
  leafId: string | null
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

const SessionEntryNode = memo(function SessionEntryNode({ data, selected }: NodeProps<SessionGraphNode>) {
  const { t } = useTranslation('components')
  const isUser = data.role === 'user'
  const isAssistant = data.role === 'assistant'
  const stateClass = data.currentLeaf
    ? 'border-accent-main-100 bg-accent-main-100/10 shadow-[0_0_0_1px_hsl(var(--accent-main-100)/0.3)]'
    : data.activePath
      ? 'border-accent-main-100/50 bg-bg-100'
      : selected
        ? 'border-text-300 bg-bg-100 shadow-[0_0_0_1px_hsl(var(--text-300)/0.3)]'
        : 'border-border-200/60 bg-bg-100'
  const roleClass = isUser
    ? 'border-l-accent-main-100'
    : isAssistant
      ? 'border-l-success-100'
      : 'border-l-warning-100'
  const RoleIcon = isUser ? UserRound : isAssistant ? Bot : data.type === 'branch_summary' ? GitBranch : data.type === 'compaction' ? FileText : Wrench

  return (
    <div
      className={`relative h-full w-[200px] overflow-hidden rounded border border-l-2 ${roleClass} ${stateClass}`}
      title={data.preview}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-bg-100 !bg-border-200" />
      <div className="flex min-w-0 items-center gap-1.5 px-2 pt-1.5">
        <RoleIcon size={11} className="shrink-0 text-text-400" aria-hidden="true" />
        <span className="min-w-0 truncate text-[length:var(--fs-xs)] font-medium text-text-300">
          {data.label || roleLabel(data, t)}
        </span>
        {data.currentLeaf ? (
          <span className="ml-auto shrink-0 text-[length:var(--fs-xxs)] font-medium text-accent-main-100">
            {t('sessionTree.currentShort')}
          </span>
        ) : data.branchCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums text-[length:var(--fs-xxs)] text-text-500">
            {data.branchCount}
          </span>
        ) : null}
      </div>
      <p className={`${data.compact ? 'line-clamp-1' : 'line-clamp-2'} break-words px-2 pb-1.5 pt-1 text-[length:var(--fs-xs)] leading-snug text-text-100`}>
        {data.preview}
      </p>
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-bg-100 !bg-border-200" />
    </div>
  )
})

const nodeTypes = { sessionEntry: SessionEntryNode }

function CanvasContent({
  tree,
  leafId,
  selectedEntryId,
  pendingEntryId,
  loading,
  error,
  onSelectEntry,
}: Omit<SessionTreeCanvasProps, 'sessionId'>) {
  const { t } = useTranslation('components')
  const [query, setQuery] = useState('')
  const { fitView, setCenter, zoomIn, zoomOut } = useReactFlow<SessionGraphNode>()
  const fittedRef = useRef(false)
  const graph = useMemo(
    () => buildSessionTreeGraph(tree, leafId, type => t(`sessionTree.entryTypes.${type}`)),
    [leafId, t, tree],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const nodes = useMemo(() => graph.nodes.map(node => ({
    ...node,
    selected: node.id === selectedEntryId,
    ariaLabel: `${node.data.label || roleLabel(node.data, t)}: ${node.data.preview}`,
    className: normalizedQuery && !`${node.data.label ?? ''} ${node.data.preview}`.toLocaleLowerCase().includes(normalizedQuery)
      ? 'opacity-25'
      : node.id === pendingEntryId ? 'animate-pulse' : undefined,
  })), [graph.nodes, normalizedQuery, pendingEntryId, selectedEntryId, t])

  const focusCurrent = useCallback(() => {
    const current = nodes.find(node => node.data.currentLeaf)
    if (!current) return
    void setCenter(current.position.x + 100, current.position.y + (current.height ?? 48) / 2, {
      zoom: 1,
      duration: 250,
    })
    onSelectEntry(current.id)
  }, [nodes, onSelectEntry, setCenter])

  useEffect(() => {
    if (fittedRef.current || nodes.length === 0) return
    fittedRef.current = true
    const frame = requestAnimationFrame(() => {
      const current = nodes.find(node => node.data.currentLeaf)
      if (current) {
        void setCenter(current.position.x + 100, current.position.y + (current.height ?? 48) / 2, {
          zoom: 0.9,
        })
        onSelectEntry(current.id)
      } else {
        void fitView({ padding: 0.15, minZoom: 0.3, maxZoom: 1.5 })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, nodes, onSelectEntry, setCenter])

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-bg-100">
      <div className="absolute left-2 right-2 top-2 z-10 flex min-w-0 items-center gap-1">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded border border-border-200 bg-bg-100/95 px-1.5 focus-within:border-accent-main-100">
          <Search size={12} className="shrink-0 text-text-500" aria-hidden="true" />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('sessionTree.search')}
            placeholder={t('sessionTree.searchPlaceholder')}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[length:var(--fs-xs)] text-text-100 outline-none placeholder:text-text-500"
          />
          <span className="shrink-0 tabular-nums text-[length:var(--fs-xxs)] text-text-500">{nodes.length}</span>
        </label>
        <IconButton aria-label={t('sessionTree.focusCurrent')} title={t('sessionTree.focusCurrent')} size="sm" onClick={focusCurrent}>
          <Focus size={13} />
        </IconButton>
        <IconButton
          aria-label={t('sessionTree.fitView')}
          title={t('sessionTree.fitView')}
          size="sm"
          onClick={() => void fitView({ padding: 0.15, minZoom: 0.2, maxZoom: 1.5, duration: 200 })}
        >
          <Maximize2 size={13} />
        </IconButton>
      </div>

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
        minZoom={0.1}
        maxZoom={3}
        fitView={false}
        proOptions={{ hideAttribution: true }}
        className="session-tree-flow"
      >
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="hsl(var(--border-200) / 0.4)" />
      </ReactFlow>

      <div className="absolute bottom-2 left-2 z-10 flex items-center gap-0.5">
        <IconButton aria-label={t('sessionTree.zoomIn')} title={t('sessionTree.zoomIn')} size="sm" onClick={() => zoomIn()}>
          <Plus size={11} />
        </IconButton>
        <IconButton aria-label={t('sessionTree.zoomOut')} title={t('sessionTree.zoomOut')} size="sm" onClick={() => zoomOut()}>
          <Minus size={11} />
        </IconButton>
      </div>

      {loading && nodes.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[length:var(--fs-xs)] text-text-400" role="status">
          {t('sessionTree.loading')}
        </div>
      ) : null}
      {!loading && nodes.length === 0 && !error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[length:var(--fs-xs)] text-text-400">
          {t('sessionTree.empty')}
        </div>
      ) : null}
      {error ? (
        <div className="absolute bottom-2 left-2 right-2 rounded border border-danger-100/30 bg-bg-100 px-2 py-1.5 text-[length:var(--fs-xxs)] text-danger-100" role="alert">
          {error}
        </div>
      ) : null}
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
