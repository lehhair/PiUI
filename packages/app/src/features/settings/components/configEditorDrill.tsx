import { useContext, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from '../../../components/Icons'
import { DrillContext, DrillDepthContext, type DrillEntry, type DrillState } from './configEditorDrillState'
import { DraftNavigationContext } from './configEditorJsonDraft'
import { tx, useLang } from './configEditorUtils'

export function Drill({
  rootTitle,
  rootKey,
  targetKey,
  targetStack,
  children,
}: {
  rootTitle: string
  rootKey: string
  targetKey?: string
  targetStack?: DrillEntry[]
  children: React.ReactNode
}) {
  const [stack, setStack] = useState<DrillEntry[]>(targetStack ?? [])
  const [prevRootKey, setPrevRootKey] = useState(rootKey)
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey)
  const pathRef = useRef<HTMLElement>(null)
  const lang = useLang()
  const canNavigate = useContext(DraftNavigationContext)

  const rootChanged = prevRootKey !== rootKey
  const targetChanged = targetKey !== undefined && prevTargetKey !== targetKey
  if (rootChanged || targetChanged) {
    setPrevRootKey(rootKey)
    setPrevTargetKey(targetKey)
    setStack(targetStack ?? [])
  }
  const liveStack = rootChanged || targetChanged ? targetStack ?? [] : stack

  const api: DrillState = {
    stack: liveStack,
    push: entry => {
      if (canNavigate()) setStack(prev => [...prev, entry])
    },
    back: toIndex => {
      if (canNavigate()) setStack(prev => prev.slice(0, toIndex))
    },
    replace: (index, entry) => setStack(prev => [...prev.slice(0, index), entry]),
  }

  const trail = [{ id: '__root__', title: rootTitle }, ...liveStack]
  const pathKey = liveStack.map(entry => `${entry.id}:${entry.title}`).join('|')

  useEffect(() => {
    const path = pathRef.current
    if (typeof path?.scrollTo !== 'function') return
    path.scrollTo({ left: path.scrollWidth, behavior: 'smooth' })
  }, [pathKey])

  return (
    <DrillContext.Provider value={api}>
      <DrillDepthContext.Provider value={0}>
        <div className="min-w-0">
          {liveStack.length > 0 && (
            <div className="mb-4 flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => api.back(liveStack.length - 1)}
                className="inline-flex h-7 shrink-0 items-center gap-0.5 text-[length:var(--fs-sm)] leading-none text-text-300 transition-colors hover:text-text-100"
              >
                <ChevronLeftIcon size={14} className="shrink-0" />
                <span className="leading-none">{tx('Back', '返回', lang)}</span>
              </button>

              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border-200" />

              <nav
                ref={pathRef}
                aria-label={tx('Config path', '配置路径', lang)}
                className="flex h-7 min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap scrollbar-none"
              >
                {trail.map((frame, index) => {
                  const isLast = index === trail.length - 1
                  return (
                    <span key={`${frame.id}:${index}`} className="flex h-7 min-w-0 shrink-0 items-center gap-1">
                      {index > 0 && (
                        <ChevronRightIcon size={14} className="shrink-0 text-text-400" />
                      )}
                      <button
                        type="button"
                        disabled={isLast}
                        onClick={() => api.back(index)}
                        aria-current={isLast ? 'page' : undefined}
                        title={frame.title}
                        className={`inline-flex h-7 min-w-0 max-w-[180px] items-center truncate text-[length:var(--fs-sm)] leading-none transition-colors ${
                          isLast
                            ? 'cursor-default font-semibold text-text-100'
                            : 'text-text-300 hover:text-text-100'
                        }`}
                      >
                        {frame.title}
                      </button>
                    </span>
                  )
                })}
              </nav>
            </div>
          )}
          {children}
        </div>
      </DrillDepthContext.Provider>
    </DrillContext.Provider>
  )
}

export function DrillChild({ depth, children }: { depth: number; children: React.ReactNode }) {
  return <DrillDepthContext.Provider value={depth + 1}>{children}</DrillDepthContext.Provider>
}

export function DrillRow({
  label,
  desc,
  preview,
  badge,
  onClick,
  onFocus,
  onBlur,
}: {
  label: string
  desc?: string
  preview?: string
  badge?: string
  onClick: () => void
  onFocus?: React.FocusEventHandler<HTMLButtonElement>
  onBlur?: React.FocusEventHandler<HTMLButtonElement>
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onFocus={onFocus}
      onBlur={onBlur}
      className="group grid w-full grid-cols-1 gap-1 py-3 text-left transition-colors sm:grid-cols-[minmax(0,1fr)_auto_14px] sm:items-center sm:gap-4"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-all text-[length:var(--fs-sm)] font-medium text-text-100">{label}</span>
          {badge && <span className="text-[10px] font-medium uppercase tracking-wide text-warning-100">{badge}</span>}
        </div>
        {desc && <div className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{desc}</div>}
      </div>
      {preview ? (
        <span className="min-w-0 max-w-full truncate text-[length:var(--fs-xs)] text-text-400 sm:max-w-[200px] sm:text-right">{preview}</span>
      ) : (
        <span className="hidden sm:block" />
      )}
      <ChevronRightIcon size={14} className="hidden shrink-0 text-text-300 sm:block" />
    </button>
  )
}
