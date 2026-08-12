import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExtensionUiDialogRequest, ExtensionUiDialogResponse } from '@piui/protocol'
import { QuestionIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from '../../components/Icons'
import { CodePreview } from '../../components/CodePreview'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { respondPiExtensionUi } from '../../pi/controllers/index.js'

/**
 * Interactive card for one pending extension UI dialog
 * (select/confirm/input/editor). Shared by the floating host above the
 * composer and the inline list in the right-sidebar extension panel.
 *
 * 设计原则（对齐 TUI / OpenCodeUI 对复杂内容的消费方式——默认只给决策
 * 所需的最小信息，长内容按需展开）：
 * - 头部永远一行摘要：标题最多 1 行，超出省略号（hover 看完整文本）
 * - 超长标题（如权限确认把工具输出塞进 title）的完整内容直接内嵌为
 *   CodePreview（固定高度内部滚动），底色与行号/卡片一致，无折叠交互
 * - 选项为紧凑单选行；操作区为一行轻量按钮
 * - 支持 Enter 提交（textarea 内除外）/ Esc 取消
 */
export function ExtensionUiDialogCard({
  request,
  queueLength = 1,
  queueIndex = 0,
  compact = false,
  onCollapse,
  onQueueNav,
}: {
  request: ExtensionUiDialogRequest
  queueLength?: number
  /** 当前显示的请求在队列中的位置（0-based）；仅 host 分页传入 */
  queueIndex?: number
  compact?: boolean
  /** 悬浮宿主传入时显示收起按钮（收起为输入框上方的胶囊）；inline 列表不传 */
  onCollapse?: () => void
  /** 队列分页切换（delta -1/1）；不传则不显示分页器 */
  onQueueNav?: (delta: -1 | 1) => void
}) {
  const { t } = useTranslation(['common', 'components'])
  const [value, setValue] = useState(() =>
    request.kind === 'select'
      ? request.options[0] ?? ''
      : request.kind === 'editor'
        ? request.prefill ?? ''
        : '',
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [responseId] = useState(() => globalThis.crypto?.randomUUID?.() ?? `${request.requestId}-${Date.now()}`)

  // 多行输入框（input kind）：随内容自动增高，封顶后内部滚动
  const multilineRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = multilineRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 64), compact ? 140 : 180)}px`
  }, [value, compact])

  // 标题是否被 line-clamp 截断：超长标题在头部只显示摘要行，完整内容
  // 直接内嵌 CodePreview（固定高度内部滚动，对齐 TUI 的消费方式）
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const [titleOverflow, setTitleOverflow] = useState(false)
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    const check = () => setTitleOverflow(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!request.expiresAt) return
    const remaining = new Date(request.expiresAt).getTime() - Date.now()
    if (remaining <= 0) {
      extensionUiStore.requestSettled(request.sessionId, request.requestId)
      return
    }
    const timer = window.setTimeout(
      () => extensionUiStore.requestSettled(request.sessionId, request.requestId),
      remaining,
    )
    return () => clearTimeout(timer)
  }, [request])

  const send = async (response: ExtensionUiDialogResponse) => {
    setSubmitting(true)
    setError(null)
    try {
      await respondPiExtensionUi(request.sessionId, request.requestId, {
        ...response,
        responseId,
      } as never)
      extensionUiStore.requestSettled(request.sessionId, request.requestId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSubmitting(false)
    }
  }

  const submit = () => {
    if (request.kind === 'confirm') return send({ confirmed: true })
    return send({ value })
  }
  const cancel = () =>
    request.kind === 'confirm' ? send({ confirmed: false }) : send({ cancelled: true })

  // Enter 提交（Shift+Enter 换行）；editor 里 Enter 换行、Ctrl/Cmd+Enter 提交；Esc 取消。
  // 中文输入法组合中（选词）的 Enter 不触发提交。
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const nativeEvent = event.nativeEvent
    if (nativeEvent.isComposing || event.keyCode === 229) return
    const target = event.target as HTMLElement
    const isTextarea = target.tagName === 'TEXTAREA'
    if (event.key === 'Enter') {
      // editor：Enter 换行，仅 Ctrl/Cmd+Enter 提交
      if (isTextarea && request.kind === 'editor' && !(event.metaKey || event.ctrlKey)) return
      // input（多行）：Shift+Enter 换行，Enter 提交
      if (isTextarea && request.kind === 'input' && event.shiftKey) return
      if (submitting || (request.kind !== 'confirm' && !value)) return
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && !submitting) {
      void cancel()
    }
  }

  const pad = compact ? 'px-3 py-2' : 'px-4 py-3'
  const gap = compact ? 'gap-2' : 'gap-2.5'
  const canSubmit = request.kind === 'confirm' || !!value

  return (
    <div
      onKeyDown={handleKeyDown}
      className={`overflow-hidden rounded-xl border border-border-200/60 bg-bg-100 shadow-float flex flex-col ${
        compact ? 'max-h-[min(440px,55vh)]' : 'max-h-[min(540px,62vh)]'
      }`}
    >
      {/* Header —— 一行摘要，永远紧凑 */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 shrink-0">
        <div className="flex min-w-0 items-center gap-2">
          <QuestionIcon size={16} className="shrink-0 text-text-400" />
          <h3
            ref={titleRef}
            title={request.title}
            className="min-w-0 line-clamp-1 whitespace-pre-wrap break-words text-[length:var(--fs-sm)] font-medium text-text-100"
          >
            {request.title}
          </h3>
          {!onQueueNav && queueLength > 1 && (
            <span className="shrink-0 rounded-md bg-bg-200 px-1.5 py-0.5 text-[length:var(--fs-xs)] text-text-400">
              +{queueLength - 1}
            </span>
          )}
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title={t('components:dialog.minimize')}
            className="shrink-0 rounded-md p-1 text-text-400 hover:bg-bg-200 hover:text-text-200 transition-colors"
          >
            <ChevronDownIcon size={14} />
          </button>
        )}
      </div>

      {/* Body —— 内容区：卡片总高受限时收缩并内部滚动；无内部分隔线 */}
      <div className={`${pad} flex flex-col ${gap} min-h-0 overflow-y-auto custom-scrollbar`}>
        {/* 超长标题：完整内容直接内嵌 CodePreview（固定高度内部滚动，
            底色与行号/卡片一致，无折叠交互） */}
        {titleOverflow && (
          <div className="overflow-hidden rounded-md border border-border-200/40 bg-bg-100">
            <CodePreview
              code={request.title}
              language="text"
              maxHeight={compact ? 100 : 140}
            />
          </div>
        )}

        {request.kind === 'confirm' && request.message && (
          <p className="whitespace-pre-wrap break-words text-[length:var(--fs-sm)] leading-relaxed text-text-200">
            {request.message}
          </p>
        )}

        {request.kind === 'select' && (
          <div className="flex flex-col gap-1">
            {request.options.map((option, index) => (
              <SelectOption
                key={`${index}-${option}`}
                option={option}
                selected={value === option}
                disabled={submitting}
                onSelect={() => setValue(option)}
              />
            ))}
          </div>
        )}

        {request.kind === 'input' && (
          <textarea
            ref={multilineRef}
            value={value}
            onChange={event => setValue(event.target.value)}
            placeholder={request.placeholder}
            disabled={submitting}
            autoFocus
            rows={2}
            className="min-h-[64px] w-full resize-none overflow-y-auto rounded-md border border-border-200 bg-bg-100 p-2.5 text-[length:var(--fs-sm)] text-text-100 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
          />
        )}

        {request.kind === 'editor' && (
          <textarea
            value={value}
            onChange={event => setValue(event.target.value)}
            disabled={submitting}
            rows={compact ? 6 : 8}
            autoFocus
            className="w-full resize-y rounded-md border border-border-200 bg-bg-100 p-3 font-mono text-[length:var(--fs-sm)] text-text-100 outline-none transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30"
          />
        )}

        {error && <p role="alert" className="text-[length:var(--fs-sm)] text-danger-100">{error}</p>}
      </div>

      {/* Actions —— 取消/提交在右；队列分页器在左；无内部分隔线 */}
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 shrink-0">
        {onQueueNav && queueLength > 1 && (
          <div className="mr-auto flex shrink-0 items-center gap-0.5 rounded-md bg-bg-200/70 px-0.5 py-0.5">
            <button
              type="button"
              onClick={() => onQueueNav(-1)}
              disabled={queueIndex === 0}
              title={t('components:dialog.previous')}
              className="flex h-5 w-5 items-center justify-center rounded text-text-400 hover:text-text-200 hover:bg-bg-000/60 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronLeftIcon size={12} />
            </button>
            <span className="px-0.5 text-[length:var(--fs-xxs)] tabular-nums text-text-400">
              {queueIndex + 1}/{queueLength}
            </span>
            <button
              type="button"
              onClick={() => onQueueNav(1)}
              disabled={queueIndex >= queueLength - 1}
              title={t('components:dialog.next')}
              className="flex h-5 w-5 items-center justify-center rounded text-text-400 hover:text-text-200 hover:bg-bg-000/60 transition-colors disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronRightIcon size={12} />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => void cancel()}
          disabled={submitting}
          className="px-2.5 py-1 rounded-md text-[length:var(--fs-sm)] text-text-400 hover:text-danger-100 transition-colors disabled:opacity-50"
        >
          {t('common:cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !canSubmit}
          className="px-3 py-1 rounded-md text-[length:var(--fs-sm)] font-medium bg-text-100 text-bg-000 hover:bg-text-200 transition-colors disabled:opacity-50"
        >
          {submitting ? '…' : request.kind === 'confirm' ? t('common:confirm') : t('common:submit')}
        </button>
      </div>
    </div>
  )
}

/**
 * 单选选项行：摘要默认 2 行截断；内容溢出时提供展开按钮，展开后内联
 * 展示完整文本（限高内部滚动）。展开/收起只影响详情，不改变选中状态。
 */
function SelectOption({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation('components')
  const textRef = useRef<HTMLSpanElement | null>(null)
  const [overflow, setOverflow] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // 溢出检测：摘要被 line-clamp-2 截断时才需要展开入口
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [option])

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-md border transition-colors ${
        selected
          ? 'border-accent-main-100/60 bg-accent-main-100/10'
          : 'border-border-200/60 bg-bg-100 hover:border-border-300'
      }`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${
              selected ? 'text-accent-secondary-100' : 'text-text-500'
            }`}
          >
            {selected && <CheckIcon size={14} />}
          </span>
          <span
            ref={textRef}
            title={option}
            className={`min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed line-clamp-2 ${
              selected ? 'text-text-100' : 'text-text-300 hover:text-text-100'
            }`}
          >
            {option}
          </span>
        </button>
        {overflow && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setExpanded(prev => !prev)}
            title={expanded ? t('dialog.collapse') : t('dialog.expand')}
            aria-expanded={expanded}
            className="mt-0.5 shrink-0 rounded p-0.5 text-text-400 hover:bg-bg-200 hover:text-text-200 transition-colors"
          >
            {expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mx-3 mb-2 max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border-200/40 bg-bg-000/40 p-2 text-[length:var(--fs-sm)] leading-relaxed text-text-200 custom-scrollbar">
          {option}
        </div>
      )}
    </div>
  )
}
