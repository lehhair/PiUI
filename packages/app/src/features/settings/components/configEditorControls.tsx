import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from '../../../components/Icons'
import { Toggle } from './SettingsUI'
import { DraftErrorContext, JsonDraftErrorContext } from './configEditorJsonDraft'
import type { Choice, JsonRecord } from './configEditorTypes'
import { asStringArray, hasOwn, isRecord, tx, useLang } from './configEditorUtils'

let draftIDSeed = 0

function useDraftReporter(context: React.Context<(id: string, invalid: boolean) => void>) {
  const report = useContext(context)
  const idRef = useRef<string | undefined>(undefined)
  if (!idRef.current) idRef.current = `config-draft-${++draftIDSeed}`
  const id = idRef.current
  useEffect(() => () => report(id, false), [id, report])
  return (invalid: boolean) => report(id, invalid)
}

/**
 * 毛玻璃面板上的输入框：
 * - 透明底
 * - 边框用 border-200（比 300 软，又不至于看不见）
 * - focus 只抬边框 + 轻 ring
 */
export const fieldClass =
  'min-w-0 w-full h-8 px-2.5 text-[length:var(--fs-sm)] rounded-md bg-transparent text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30'

export const fieldAreaClass =
  'min-w-0 w-full min-h-[5rem] px-2.5 py-2 text-[length:var(--fs-sm)] rounded-md bg-transparent text-text-100 placeholder:text-text-400 outline-none border border-border-200 transition-colors hover:border-border-300 focus-visible:border-accent-main-100 focus-visible:ring-1 focus-visible:ring-accent-main-100/30 resize-y leading-relaxed custom-scrollbar'

function enumChoices(values: string[]): Choice[] {
  return values.map(value => ({ value, label: value }))
}

export function TextField({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: unknown
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <input
      value={value === undefined || value === null ? '' : String(value)}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      className={`${fieldClass} ${mono ? 'font-mono' : ''}`}
    />
  )
}

export function TextArea({ value, onChange, placeholder, rows = 4 }: { value: unknown; onChange: (value: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      value={value === undefined || value === null ? '' : String(value)}
      onChange={event => onChange(event.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={fieldAreaClass}
    />
  )
}

function isNumericDraft(raw: string) {
  return raw === '' || /^-?\d*\.?\d*$/.test(raw)
}

function isIntegerDraft(raw: string) {
  return raw === '' || /^-?\d*$/.test(raw)
}

/** 输入过程只改本地 draft，失焦再提交 number，避免 4096 改中间态被规范化成 96 */
export function NumberField({
  value,
  onChange,
  placeholder,
}: {
  value: unknown
  onChange: (value: number | undefined) => void
  placeholder?: string
}) {
  const lang = useLang()
  const reportInvalid = useDraftReporter(DraftErrorContext)
  const external = typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  const [draft, setDraft] = useState(external)
  const [focused, setFocused] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const initialValueRef = useRef<number | undefined>(undefined)
  const displayed = focused ? draft : external

  return (
    <div className="space-y-1">
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={displayed}
        placeholder={placeholder}
        onFocus={() => {
          initialValueRef.current = typeof value === 'number' && Number.isFinite(value) ? value : undefined
          setDraft(external)
          setFocused(true)
        }}
        onChange={event => {
          const raw = event.target.value
          if (!isNumericDraft(raw.trim())) return
          setDraft(raw)
          const nextRaw = raw.trim()
          if (nextRaw === '' || nextRaw === '-' || nextRaw === '.' || nextRaw === '-.') {
            setInvalid(false)
            reportInvalid(true)
            return
          }
          const next = Number(nextRaw)
          setInvalid(!Number.isFinite(next))
          reportInvalid(!Number.isFinite(next))
          if (Number.isFinite(next)) onChange(next)
        }}
        onBlur={() => {
          const raw = draft.trim()
          if (raw === '' || raw === '-' || raw === '.' || raw === '-.') {
            onChange(initialValueRef.current)
            setInvalid(false)
            reportInvalid(false)
            setFocused(false)
            return
          }
          const next = Number(raw)
          if (Number.isFinite(next)) onChange(next)
          else onChange(initialValueRef.current)
          setInvalid(false)
          reportInvalid(false)
          setFocused(false)
        }}
        className={`${fieldClass} ${invalid ? '!border-error-100' : ''}`}
      />
      {focused && draft.trim() === '' && external !== '' && (
        <div className="text-[length:var(--fs-xs)] text-text-400">
          {tx('Empty input will not remove a saved value; enter a new number or Reset before saving.', '留空不会删除已保存值；请输入新数字，或保存前 Reset。', lang)}
        </div>
      )}
      {invalid && <div className="text-[length:var(--fs-xs)] text-error-100">{tx('Must be a valid number.', '必须是有效数字。', lang)}</div>}
    </div>
  )
}

export function IntegerField({
  value,
  onChange,
  min,
  max,
  positive,
}: {
  value: unknown
  onChange: (value: number | undefined) => void
  min?: number
  max?: number
  positive?: boolean
}) {
  const lang = useLang()
  const reportInvalid = useDraftReporter(DraftErrorContext)
  const numberValue = typeof value === 'number' ? value : undefined
  const external = numberValue !== undefined && Number.isFinite(numberValue) ? String(numberValue) : ''
  const [draft, setDraft] = useState(external)
  const [focused, setFocused] = useState(false)
  const initialValueRef = useRef<number | undefined>(undefined)
  const displayed = focused ? draft : external
  const raw = displayed.trim()
  const parsed = raw === '' || raw === '-' ? undefined : Number(raw)
  const invalid =
    parsed !== undefined &&
    (!Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      (positive && parsed <= 0) ||
      (min !== undefined && parsed < min) ||
      (max !== undefined && parsed > max))

  return (
    <div className="space-y-1">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={displayed}
        onFocus={() => {
          initialValueRef.current = numberValue
          setDraft(external)
          setFocused(true)
        }}
        onChange={event => {
          const next = event.target.value
          if (!isIntegerDraft(next.trim())) return
          setDraft(next)
          const nextRaw = next.trim()
          if (nextRaw === '' || nextRaw === '-') {
            onChange(initialValueRef.current)
            reportInvalid(true)
            return
          }
          const parsedNext = Number(nextRaw)
          if (
            Number.isFinite(parsedNext) &&
            Number.isInteger(parsedNext) &&
            !(positive && parsedNext <= 0) &&
            !(min !== undefined && parsedNext < min) &&
            !(max !== undefined && parsedNext > max)
          ) {
            reportInvalid(false)
            onChange(parsedNext)
          } else {
            reportInvalid(true)
          }
        }}
        onBlur={() => {
          const nextRaw = draft.trim()
          if (nextRaw === '' || nextRaw === '-') {
            reportInvalid(false)
            setFocused(false)
            return
          }
          const next = Number(nextRaw)
          if (
            Number.isFinite(next) &&
            Number.isInteger(next) &&
            !(positive && next <= 0) &&
            !(min !== undefined && next < min) &&
            !(max !== undefined && next > max)
          ) {
            onChange(next)
          } else onChange(initialValueRef.current)
          reportInvalid(false)
          setFocused(false)
        }}
        className={`${fieldClass} ${invalid ? '!border-error-100' : ''}`}
      />
      {focused && raw === '' && external !== '' && (
        <div className="text-[length:var(--fs-xs)] text-text-400">
          {tx('Empty input will not remove a saved value; enter a new integer or Reset before saving.', '留空不会删除已保存值；请输入新整数，或保存前 Reset。', lang)}
        </div>
      )}
      {invalid && (
        <div className="text-[length:var(--fs-xs)] text-error-100">
          {tx('Must be an integer in the allowed range.', '必须是允许范围内的整数。', lang)}
        </div>
      )}
    </div>
  )
}

export function PositiveIntegerField(props: { value: unknown; onChange: (value: number | undefined) => void }) {
  return <IntegerField {...props} positive />
}

export function PortField(props: { value: unknown; onChange: (value: number | undefined) => void }) {
  return <IntegerField {...props} min={1} max={65535} />
}

export function BoolField({ value, onChange }: { value: unknown; onChange: (value: boolean) => void }) {
  return (
    <div className="flex h-full items-center">
      <Toggle enabled={Boolean(value)} onChange={() => onChange(!value)} />
    </div>
  )
}

export function NumberOrFalseField({ value, onChange }: { value: unknown; onChange: (value: number | false | undefined) => void }) {
  const mode = value === false ? 'false' : 'number'
  return (
    <div className="grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)]">
      <Select
        value={mode}
        options={[
          { value: 'number', label: 'number' },
          { value: 'false', label: 'false' },
        ]}
        onChange={next => onChange(next === 'false' ? false : typeof value === 'number' ? value : undefined)}
      />
      {mode === 'number' && <PositiveIntegerField value={value} onChange={onChange} />}
    </div>
  )
}

export function Select({
  value,
  options,
  onChange,
  placeholder,
  editable,
}: {
  value: unknown
  options: Choice[]
  onChange: (value: string) => void
  placeholder?: string
  editable?: boolean
}) {
  const lang = useLang()
  const menuId = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties>({})

  const current = value === undefined || value === null ? '' : String(value)
  const selected = options.find(option => option.value === current)
  const display = selected ? selected.label : current

  const query = open && editable ? draft : ''
  const filtered = options.filter(option => {
    if (!query) return true
    const q = query.toLowerCase()
    return option.label.toLowerCase().includes(q) || option.value.toLowerCase().includes(q)
  })

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const below = window.innerHeight - rect.bottom
    const openUp = below < 280 && rect.top > below
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16)
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8)
    setPos({
      left,
      width,
      maxWidth: 'calc(100vw - 16px)',
      ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(place)
    const onDown = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return
      if (menuRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onScroll = () => place()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
      cancelAnimationFrame(raf)
    }
  }, [open, place])

  return (
    <div ref={triggerRef} className="relative min-w-0 flex-1">
      {editable && open ? (
        <input
          autoFocus
          role="combobox"
          aria-expanded={open}
          aria-controls={menuId}
          value={draft}
          placeholder={display || placeholder}
          onChange={event => {
            setDraft(event.target.value)
            onChange(event.target.value)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
          className={`${fieldClass} pr-9`}
        />
      ) : (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => {
            setDraft(current)
            setOpen(o => !o)
          }}
          onKeyDown={event => {
            if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            }
          }}
          className={`${fieldClass} flex items-center justify-between gap-2 text-left ${
            display ? '' : 'text-text-400'
          }`}
        >
          <span className="truncate">{display || placeholder || tx('Select…', '选择…', lang)}</span>
          {/* 收起朝右，展开朝下 */}
          {open ? (
            <ChevronDownIcon size={14} className="shrink-0 text-text-300" />
          ) : (
            <ChevronRightIcon size={14} className="shrink-0 text-text-300" />
          )}
        </button>
      )}
      {editable && open && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={tx('Close options', '关闭选项', lang)}
          onClick={() => setOpen(false)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-text-300 transition-colors hover:bg-bg-100 hover:text-text-100"
        >
          <ChevronDownIcon size={14} />
        </button>
      )}
      {open &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            role="listbox"
            className="fixed z-[400] max-h-64 overflow-y-auto rounded-lg border border-border-200 glass p-1 shadow-lg custom-scrollbar"
            style={pos}
          >
            {filtered.length === 0 && (
              <div className="px-3 py-2.5 text-[length:var(--fs-xs)] text-text-400">{tx('No matches', '无匹配项', lang)}</div>
            )}
            {filtered.map(option => (
              <button
                key={`${option.value}|${option.label}`}
                type="button"
                role="option"
                aria-selected={option.value === current}
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] transition-colors disabled:opacity-40 ${
                  option.value === current
                    ? 'bg-bg-200 text-text-100'
                    : 'text-text-100 hover:bg-bg-100'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate">{option.label}</span>
                  {option.hint && <span className="mt-0.5 block truncate text-[length:var(--fs-xs)] text-text-400">{option.hint}</span>}
                </span>
                {option.value === current && <CheckIcon size={14} className="shrink-0 text-text-200" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}

export function StringListField({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: unknown
  onChange: (value: string[]) => void
  placeholder?: string
  mono?: boolean
}) {
  const lang = useLang()
  if (Array.isArray(value) && value.some(item => typeof item !== 'string')) {
    return (
      <div className="space-y-2">
        <div className="text-[length:var(--fs-xs)] text-warning-100">{tx('This field contains non-string items. Repair the JSON array before saving.', '该字段包含非字符串项，请在保存前修复 JSON 数组。', lang)}</div>
        <JsonStructuredEditor value={value} type="array" onChange={next => onChange(next as string[])} />
      </div>
    )
  }
  const list = asStringArray(value)
  return (
    <div className="space-y-2">
      {list.map((item, index) => (
        <div key={index} className="flex min-w-0 items-center gap-1.5">
          <input
            value={item}
            onChange={event => {
              const next = [...list]
              next[index] = event.target.value
              onChange(next)
            }}
            placeholder={placeholder}
            className={`${fieldClass} ${mono ? 'font-mono' : ''}`}
          />
          <button
            type="button"
            aria-label={tx(`Remove item ${index + 1}`, `删除第 ${index + 1} 项`, lang)}
            onClick={() => onChange(list.filter((_, i) => i !== index))}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 transition-colors hover:bg-bg-200/40 hover:text-error-100"
          >
            <TrashIcon size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...list, ''])}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[length:var(--fs-sm)] font-medium text-accent-main-100 transition-colors hover:bg-accent-main-100/10"
      >
        <PlusIcon size={13} />
        {tx('Add', '添加', '')}
      </button>
    </div>
  )
}

type JsonValueType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'

function jsonValueType(value: unknown): JsonValueType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (isRecord(value)) return 'object'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

function emptyJsonValue(type: JsonValueType): unknown {
  switch (type) {
    case 'number':
      return 0
    case 'boolean':
      return true
    case 'object':
      return {}
    case 'array':
      return []
    case 'null':
      return null
    case 'string':
      return ''
  }
}

export function JsonStructuredEditor({ value, type, onChange }: { value: unknown; type: 'object' | 'array'; onChange: (value: unknown) => void }) {
  const lang = useLang()
  const reportDraftError = useContext(JsonDraftErrorContext)
  const draftID = useRef<string | undefined>(undefined)
  if (!draftID.current) draftID.current = `json-draft-${++draftIDSeed}`
  const currentDraftID = draftID.current
  const [error, setError] = useState<string | null>(null)
  const text = JSON.stringify(value ?? emptyJsonValue(type), null, 2)
  const [draft, setDraft] = useState(text)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(text)
    setError(null)
    reportDraftError(currentDraftID, false)
  }, [text, currentDraftID, reportDraftError])
  useEffect(() => () => reportDraftError(currentDraftID, false), [currentDraftID, reportDraftError])

  const parseDraft = (nextDraft: string) => {
    try {
      const next = JSON.parse(nextDraft)
      if (type === 'object' && !isRecord(next)) {
        const message = tx('Expected a JSON object.', '需要 JSON object。', lang)
        setError(message)
        reportDraftError(currentDraftID, true)
        return
      }
      if (type === 'array' && !Array.isArray(next)) {
        const message = tx('Expected a JSON array.', '需要 JSON array。', lang)
        setError(message)
        reportDraftError(currentDraftID, true)
        return
      }
      setError(null)
      reportDraftError(currentDraftID, false)
      return next
    } catch {
      setError(tx('Invalid JSON.', 'JSON 无效。', lang))
      reportDraftError(currentDraftID, true)
    }
    return undefined
  }
  return (
    <div className="space-y-1">
      <textarea
        value={draft}
        rows={Math.min(10, Math.max(4, draft.split('\n').length))}
        onFocus={() => {
          focused.current = true
        }}
        onChange={event => {
          const nextDraft = event.target.value
          setDraft(nextDraft)
          const next = parseDraft(nextDraft)
          if (next !== undefined) onChange(next)
        }}
        onBlur={() => {
          focused.current = false
          const next = parseDraft(draft)
          if (next !== undefined) {
            onChange(next)
            setDraft(JSON.stringify(next, null, 2))
          }
        }}
        className={`${fieldAreaClass} font-mono`}
      />
      {error && <div className="text-[length:var(--fs-xs)] text-error-100">{error}</div>}
    </div>
  )
}

function JsonValueEditor({ value, onChange, placeholder }: { value: unknown; onChange: (value: unknown) => void; placeholder?: string }) {
  const type = jsonValueType(value)
  switch (type) {
    case 'number':
      return <NumberField value={value} onChange={next => onChange(next ?? 0)} />
    case 'boolean':
      return <BoolField value={value} onChange={onChange} />
    case 'object':
    case 'array':
      return <JsonStructuredEditor value={value} type={type} onChange={onChange} />
    case 'null':
      return <input value="null" disabled className={`${fieldClass} text-text-400`} />
    case 'string':
      return <TextField value={value} onChange={onChange} placeholder={placeholder} mono />
  }
}

export function KeyValueField({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value: unknown
  onChange: (value: JsonRecord) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  const lang = useLang()
  const reportIncomplete = useDraftReporter(DraftErrorContext)
  const record = isRecord(value) ? value : {}
  const [newKey, setNewKey] = useState('')
  const [newType, setNewType] = useState<JsonValueType>('string')
  const entries = Object.entries(record)
  const typeOptions = enumChoices(['string', 'number', 'boolean', 'object', 'array', 'null'])
  const targetKey = newKey.trim()
  const addEntry = () => {
    if (!targetKey || hasOwn(record, targetKey)) return
    onChange({ ...record, [targetKey]: emptyJsonValue(newType) })
    setNewKey('')
    reportIncomplete(false)
  }
  return (
    <div className="space-y-3">
      {entries.map(([key, item]) => {
        const type = jsonValueType(item)
        return (
          <div key={key} className="space-y-2 border-b border-border-200/40 pb-3 last:border-b-0 last:pb-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-sm)] font-medium text-text-100">
                {key}
              </div>
              <div className="w-full sm:w-40">
                <Select value={type} options={typeOptions} onChange={next => onChange({ ...record, [key]: emptyJsonValue(next as JsonValueType) })} />
              </div>
            </div>
            <JsonValueEditor value={item} onChange={next => onChange({ ...record, [key]: next })} placeholder={valuePlaceholder} />
          </div>
        )
      })}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={newKey}
          onChange={event => {
            setNewKey(event.target.value)
            reportIncomplete(event.target.value.trim() !== '')
          }}
          placeholder={keyPlaceholder ?? tx('new key', '新键名', lang)}
          className={`${fieldClass} min-w-0 flex-1 font-mono`}
        />
        <div className="flex min-w-0 items-center gap-2 sm:w-52">
          <Select value={newType} options={typeOptions} onChange={next => setNewType(next as JsonValueType)} />
          <button
            type="button"
            disabled={!targetKey || hasOwn(record, targetKey)}
            onClick={addEntry}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-200 px-2.5 text-[length:var(--fs-sm)] font-medium text-text-100 transition-colors hover:border-border-300 disabled:opacity-40"
          >
            <PlusIcon size={13} />
            {tx('Add', '添加', lang)}
          </button>
        </div>
      </div>
      <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">
        {tx('Existing object keys cannot be reliably deleted through the official merge API; change values instead, or reset before saving newly added keys.', '官方 merge API 不能可靠删除已保存的 object key；请改值，刚新增但不想保存的键可以在保存前 Reset。', lang)}
      </div>
    </div>
  )
}

export function StringMapField({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value: unknown
  onChange: (value: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  const lang = useLang()
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const reportIncomplete = useDraftReporter(DraftErrorContext)
  if (isRecord(value) && Object.values(value).some(item => typeof item !== 'string')) {
    return (
      <div className="space-y-2">
        <div className="text-[length:var(--fs-xs)] text-warning-100">{tx('This map contains non-string values. Repair the JSON object before saving.', '该 map 包含非字符串值，请在保存前修复 JSON 对象。', lang)}</div>
        <JsonStructuredEditor value={value} type="object" onChange={next => onChange(next as Record<string, string>)} />
      </div>
    )
  }
  const record = isRecord(value) ? (value as Record<string, string>) : {}
  const targetKey = newKey.trim()
  const addEntry = () => {
    if (!targetKey || hasOwn(record, targetKey)) return
    onChange({ ...record, [targetKey]: newValue })
    setNewKey('')
    setNewValue('')
    reportIncomplete(false)
  }
  return (
    <div className="space-y-3">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_12px_minmax(0,1fr)_32px] items-center gap-2 px-1 text-[length:var(--fs-xs)] font-medium text-text-400">
        <span>{tx('Key', '键', lang)}</span>
        <span aria-hidden="true" />
        <span>{tx('Value', '值', lang)}</span>
        <span aria-hidden="true" />
      </div>
      {Object.entries(record).map(([key, item]) => (
        <div key={key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_12px_minmax(0,1fr)_32px] items-center gap-2">
          <div title={key} className={`${fieldClass} flex min-w-0 items-center truncate font-mono text-text-200`}>
            {key}
          </div>
          <span aria-hidden="true" className="text-center font-mono text-[length:var(--fs-sm)] text-text-400">=</span>
          <TextField value={item} onChange={next => onChange({ ...record, [key]: next })} placeholder={valuePlaceholder ?? tx('value', '值', lang)} mono />
          <span aria-hidden="true" />
        </div>
      ))}
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_12px_minmax(0,1fr)_32px] items-center gap-2"
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) addEntry()
        }}
      >
        <input
          value={newKey}
          onChange={event => {
            setNewKey(event.target.value)
            reportIncomplete(event.target.value.trim() !== '' || newValue !== '')
          }}
          placeholder={keyPlaceholder ?? tx('new key', '新键名', lang)}
          className={`${fieldClass} min-w-0 flex-1 font-mono`}
        />
        <span aria-hidden="true" className="text-center font-mono text-[length:var(--fs-sm)] text-text-400">=</span>
        <input
          value={newValue}
          onChange={event => {
            setNewValue(event.target.value)
            reportIncomplete(targetKey !== '' || event.target.value !== '')
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') addEntry()
          }}
          placeholder={valuePlaceholder ?? tx('value', '值', lang)}
          className={`${fieldClass} min-w-0 flex-1 font-mono`}
        />
        <button
          type="button"
          aria-label={tx('Add key-value pair', '添加键值对', lang)}
          title={tx('Add key-value pair', '添加键值对', lang)}
          disabled={!targetKey || hasOwn(record, targetKey)}
          onClick={addEntry}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-200 text-text-100 transition-colors hover:border-border-300 disabled:opacity-40"
        >
          <PlusIcon size={13} />
        </button>
      </div>
      <div className="text-[length:var(--fs-xs)] leading-relaxed text-text-400">
        {tx('This map only accepts string values. Existing keys cannot be reliably deleted through the official merge API.', '这个 map 只接受字符串值。官方 merge API 不能可靠删除已保存的 key。', lang)}
      </div>
    </div>
  )
}
