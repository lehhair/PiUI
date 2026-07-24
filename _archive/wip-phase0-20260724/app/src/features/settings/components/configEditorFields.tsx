import { useContext, useId, useState } from 'react'
import type React from 'react'
import { ChevronRightIcon, CopyIcon, PlusIcon } from '../../../components/Icons'
import { Drill, DrillChild, DrillRow } from './configEditorDrill'
import { DrillContext, useDrillContainer, ValidationDrillTargetContext } from './configEditorDrillState'
import { SECTION_META } from './configEditorMeta'
import type { JsonRecord, Lang, SectionID } from './configEditorTypes'
import { fieldClass } from './configEditorControls'
import { hasOwn, suggestCopyId, tx } from './configEditorUtils'

export type FieldDef = {
  key: string
  label: string
  desc?: string
  badge?: string
  block?: boolean
  drill?: { title: string; preview?: string; render: () => React.ReactNode }
  control?: React.ReactNode
}

/**
 * 表单行布局（Apple / Linear 列表感）：
 * - 左：标题 + 描述纵向叠
 * - 右：控件垂直居中，宽度固定但不夸张
 * - 行与行之间用细分割线，不用大间距/卡片
 */
export function FieldRow({
  label,
  desc,
  badge,
  block,
  control,
  onFocus,
  onBlur,
}: Omit<FieldDef, 'key'> & {
  onFocus?: React.FocusEventHandler<HTMLDivElement>
  onBlur?: React.FocusEventHandler<HTMLDivElement>
}) {
  if (block) {
    return (
      <div className="py-3" onFocus={onFocus} onBlur={onBlur}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-all text-[length:var(--fs-sm)] font-medium text-text-100">{label}</span>
          {badge && (
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-warning-100">
              {badge}
            </span>
          )}
        </div>
        {desc && <p className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{desc}</p>}
        <div className="mt-2 min-w-0 max-w-lg">{control}</div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_200px] sm:items-center sm:gap-6" onFocus={onFocus} onBlur={onBlur}>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-all text-[length:var(--fs-sm)] font-medium text-text-100">{label}</span>
          {badge && (
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-warning-100">
              {badge}
            </span>
          )}
        </div>
        {desc && <p className="mt-0.5 text-[length:var(--fs-xs)] leading-relaxed text-text-300">{desc}</p>}
      </div>
      <div className="min-w-0 sm:justify-self-end sm:w-full">{control}</div>
    </div>
  )
}

export function EmptyHint({ text }: { text: string }) {
  return <div className="py-2 text-[length:var(--fs-sm)] text-text-400">{text}</div>
}

function FieldRenderer({
  field,
  onEnter,
  onFieldFocus,
  onFieldBlur,
}: {
  field: FieldDef
  onEnter: (field: FieldDef) => void
  onFieldFocus?: (field: FieldDef) => void
  onFieldBlur?: (fieldKey: string, currentTarget: HTMLElement, relatedTarget: EventTarget | null) => void
}) {
  const handleFocus = () => onFieldFocus?.(field)
  const handleBlur = (event: React.FocusEvent<HTMLElement>) => onFieldBlur?.(field.key, event.currentTarget, event.relatedTarget)
  if (field.drill) {
    const d = field.drill
    return (
      <div data-config-field={field.key}>
        <DrillRow
          label={field.label}
          desc={field.desc}
          badge={field.badge}
          preview={d.preview}
          onClick={() => onEnter(field)}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
      </div>
    )
  }
  return (
    <div data-config-field={field.key}>
      <FieldRow
        label={field.label}
        desc={field.desc}
        badge={field.badge}
        block={field.block}
        control={field.control}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
    </div>
  )
}

export function GroupedFields({
  fields,
  isConfigured,
  lang,
  onEnter,
}: {
  fields: FieldDef[]
  isConfigured: (key: string) => boolean
  lang: Lang
  onEnter?: (field: FieldDef) => void
}) {
  const handleEnter = onEnter ?? (() => {})
  const [focusedField, setFocusedField] = useState<{ key: string; group: 'configured' | 'available' } | null>(null)
  const focusedAvailableKey = focusedField?.group === 'available' ? focusedField.key : null
  const configured = fields.filter(field => isConfigured(field.key) && field.key !== focusedAvailableKey)
  const available = fields.filter(field => !isConfigured(field.key) || field.key === focusedAvailableKey)

  const handleFieldFocus = (field: FieldDef) => {
    const group = isConfigured(field.key) ? 'configured' : 'available'
    setFocusedField(prev => (prev?.key === field.key && prev.group === group ? prev : { key: field.key, group }))
  }
  const handleFieldBlur = (fieldKey: string, currentTarget: HTMLElement, relatedTarget: EventTarget | null) => {
    if (relatedTarget instanceof Node && currentTarget.contains(relatedTarget)) return
    setFocusedField(prev => (prev?.key === fieldKey ? null : prev))
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <GroupHeader text={tx('Configured', '已配置', lang)} count={configured.length} accent />
        {configured.length === 0 ? (
          <EmptyHint text={tx('No fields configured yet.', '还没有配置任何字段。', lang)} />
        ) : (
          <div className="divide-y divide-border-200/35">
            {configured.map(field => (
              <FieldRenderer
                key={field.key}
                field={field}
                onEnter={handleEnter}
                onFieldFocus={handleFieldFocus}
                onFieldBlur={handleFieldBlur}
              />
            ))}
          </div>
        )}
      </section>

      {available.length > 0 && (
        <section>
          <GroupHeader text={tx('Available', '可配置', lang)} count={available.length} />
          <div className="divide-y divide-border-200/25">
            {available.map(field => (
              <FieldRenderer
                key={field.key}
                field={field}
                onEnter={handleEnter}
                onFieldFocus={handleFieldFocus}
                onFieldBlur={handleFieldBlur}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export function GroupHeader({ text, count, accent }: { text: string; count: number; accent?: boolean }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <span className={`text-[length:var(--fs-sm)] font-medium ${accent ? 'text-text-100' : 'text-text-300'}`}>{text}</span>
      <span className="text-[length:var(--fs-xs)] tabular-nums text-text-400">{count}</span>
    </div>
  )
}

export function DuplicateIdField({
  sourceId,
  existing,
  lang,
  onCopy,
}: {
  sourceId: string
  existing: JsonRecord
  lang: Lang
  onCopy: (targetId: string) => void
}) {
  const inputId = useId()
  const suggestion = suggestCopyId(sourceId, existing)
  const [draft, setDraft] = useState(() => ({ sourceId, targetId: suggestion }))
  const targetId = draft.sourceId === sourceId ? draft.targetId : suggestion

  const target = targetId.trim()
  const exists = hasOwn(existing, target)
  const copy = () => {
    if (!target || exists) return
    onCopy(target)
  }

  return (
    <div className="space-y-2 pb-3">
      <label htmlFor={inputId} className="text-[length:var(--fs-sm)] font-medium text-text-100">{tx('Copy as…', '复制为…', lang)}</label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={inputId}
          value={targetId}
          onChange={event => setDraft({ sourceId, targetId: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter') copy()
          }}
          placeholder={tx('new id', '新 id', lang)}
          className={`${fieldClass} min-w-0 flex-1 font-mono`}
        />
        <button
          type="button"
          disabled={!target || exists}
          onClick={copy}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-200 px-2.5 text-[length:var(--fs-sm)] font-medium text-text-100 transition-colors hover:border-border-300 disabled:opacity-40"
        >
          <CopyIcon size={13} />
          {tx('Copy', '复制', lang)}
        </button>
      </div>
      {exists && <div className="text-[length:var(--fs-xs)] text-warning-100">{tx('This id already exists.', '该 id 已存在。', lang)}</div>}
    </div>
  )
}

export function DrillFields({ fields, isConfigured, lang }: { fields: FieldDef[]; isConfigured: (key: string) => boolean; lang: Lang }) {
  const { activeChildId, enter, depth } = useDrillContainer()
  if (activeChildId) {
    const active = fields.find(field => field.drill && field.key === activeChildId)
    if (active?.drill) {
      return (
        <DrillChild depth={depth}>
          <div data-config-field={active.key}>{active.drill.render()}</div>
        </DrillChild>
      )
    }
  }
  return (
    <GroupedFields
      fields={fields}
      isConfigured={isConfigured}
      lang={lang}
      onEnter={field => field.drill && enter({ id: field.key, title: field.drill.title })}
    />
  )
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  const drill = useContext(DrillContext)
  // 下钻后隐藏分区标题，避免和面包屑重复
  if (drill && drill.stack.length > 0) return null
  return (
    <div className="mb-4">
      <h2 className="text-[length:var(--fs-md)] font-semibold text-text-100">{title}</h2>
      <p className="mt-1 max-w-[52ch] text-[length:var(--fs-xs)] leading-relaxed text-text-300">{description}</p>
    </div>
  )
}

export function SectionShell({ id, lang, drillKey, children }: { id: SectionID; lang: Lang; drillKey?: string; children: React.ReactNode }) {
  const meta = SECTION_META[id]
  const target = useContext(ValidationDrillTargetContext)
  const activeTarget = target?.section === id ? target : null
  const title = tx(meta.en, meta.zh, lang)
  const description = tx(meta.descEn, meta.descZh, lang)
  return (
    <section data-config-section={id} className="min-w-0">
      <Drill rootTitle={title} rootKey={drillKey ?? id} targetKey={activeTarget?.key} targetStack={activeTarget?.stack}>
        <SectionHeading title={title} description={description} />
        {children}
      </Drill>
    </section>
  )
}

export function NamedDrillList({
  lang,
  items,
  addPlaceholder,
  onOpen,
  onAdd,
  builtins,
  renderPreview,
  emptyText,
}: {
  lang: Lang
  items: string[]
  addPlaceholder: string
  onOpen: (name: string) => void
  onAdd: (name: string) => void
  builtins?: string[]
  renderPreview?: (name: string) => string
  emptyText?: string
}) {
  const [newName, setNewName] = useState('')
  const targetName = newName.trim()
  const nameExists = items.includes(targetName)
  const add = () => {
    if (!targetName || nameExists) return
    onAdd(targetName)
    onOpen(targetName)
    setNewName('')
  }

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <EmptyHint text={emptyText ?? tx('No items yet.', '还没有条目。', lang)} />
      ) : (
        <div className="divide-y divide-border-200/35">
          {items.map(name => (
            <button
              key={name}
              type="button"
              onClick={() => onOpen(name)}
              className="group grid w-full grid-cols-[minmax(0,1fr)_14px] items-center gap-3 py-3 text-left"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[length:var(--fs-sm)] font-medium text-text-100">{name}</span>
                  {builtins?.includes(name) && (
                    <span className="shrink-0 text-[length:var(--fs-xs)] text-text-400">
                      {tx('built-in', '内置', lang)}
                    </span>
                  )}
                </div>
                {renderPreview && <div className="mt-0.5 truncate text-[length:var(--fs-xs)] text-text-400">{renderPreview(name)}</div>}
              </div>
              <ChevronRightIcon size={14} className="shrink-0 text-text-300" />
            </button>
          ))}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <input
          value={newName}
          onChange={event => setNewName(event.target.value)}
          placeholder={addPlaceholder}
          onKeyDown={event => {
            if (event.key === 'Enter') add()
          }}
          className={`${fieldClass} min-w-0 flex-1 font-mono`}
        />
        <button
          type="button"
          disabled={!targetName || nameExists}
          onClick={add}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-border-200 px-2.5 text-[length:var(--fs-sm)] font-medium text-text-100 transition-colors hover:border-border-300 disabled:opacity-40"
        >
          <PlusIcon size={14} />
          {tx('Add', '添加', lang)}
        </button>
      </div>
      {nameExists && <div className="text-[length:var(--fs-xs)] text-warning-100">{tx('This id already exists.', '该 id 已存在。', lang)}</div>}
    </div>
  )
}
