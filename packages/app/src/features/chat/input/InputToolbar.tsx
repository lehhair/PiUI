import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, SendIcon, StopIcon, PaperclipIcon, ThinkingIcon } from '../../../components/Icons'
import { DropdownMenu, MenuItem, IconButton, AnimatedPresence } from '../../../components/ui'
import { ModelSelector, type ModelSelectorHandle } from '../ModelSelector'
import { useChatViewportSelect } from '../chatViewport'
import { isTauri, isTauriMobile, extToMime } from '../../../utils/tauri'
import type { Model, Api } from '@earendil-works/pi-ai'
import type { FileCapabilities } from '../../../types/ui'

type ModelInfo = Model<Api>

interface InputToolbarProps {
  variants?: string[]
  selectedVariant?: string
  onVariantChange?: (variant: string | undefined) => void

  fileCapabilities?: FileCapabilities
  onFilesSelected: (files: File[]) => void

  isStreaming?: boolean
  /** 兜底：session 在活跃列表中时即使 isStreaming 为 false 也显示停止按钮 */
  sessionActive?: boolean
  /** 上下文压缩进行中：发送按钮变为停止按钮（取消压缩） */
  isCompacting?: boolean
  isSending?: boolean
  onAbort?: () => void
  deliveryMode?: 'steer' | 'followUp'
  onDeliveryModeChange?: (mode: 'steer' | 'followUp') => void
  canSteer?: boolean
  canFollowUp?: boolean

  canSend: boolean
  onSend: () => void

  // Model selection（移动端显示在工具栏）
  models?: ModelInfo[]
  selectedModelKey?: string | null
  onModelChange?: (modelKey: string, model: ModelInfo) => void
  modelsLoading?: boolean
  // 输入框容器 ref，用于约束菜单边界
  inputContainerRef?: React.RefObject<HTMLDivElement | null>
  modelSelectorRef?: React.RefObject<ModelSelectorHandle | null>
}

export function InputToolbar({
  variants = [],
  selectedVariant,
  onVariantChange,
  fileCapabilities,
  onFilesSelected,
  isStreaming,
  sessionActive,
  isCompacting = false,
  isSending = false,
  onAbort,
  deliveryMode = 'followUp',
  onDeliveryModeChange,
  canSteer = false,
  canFollowUp = false,
  canSend,
  onSend,
  models = [],
  selectedModelKey = null,
  onModelChange,
  modelsLoading = false,
  inputContainerRef,
  modelSelectorRef,
}: InputToolbarProps) {
  const { t } = useTranslation(['chat', 'common'])
  const isCompact = useChatViewportSelect(value => value.presentation.isCompact)
  const useBrowserFileInput = !isTauri() || isTauriMobile()

  // 根据模型能力计算支持的文件类型
  const caps = fileCapabilities ?? { image: false, pdf: false, audio: false, video: false }
  const supportsAnyFile = caps.image || caps.pdf || caps.audio || caps.video
  const controlsDisabled = isSending

  // 动态构建 HTML accept 和 Tauri filter
  const { acceptString, tauriFilters } = useMemo(() => {
    const accept: string[] = []
    const extensions: string[] = []
    const filterNames: string[] = []

    if (caps.image) {
      accept.push('image/*')
      extensions.push('png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg')
      filterNames.push('Images')
    }
    if (caps.pdf) {
      accept.push('application/pdf')
      extensions.push('pdf')
      filterNames.push('PDF')
    }
    if (caps.audio) {
      accept.push('audio/*')
      extensions.push('mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a')
      filterNames.push('Audio')
    }
    if (caps.video) {
      accept.push('video/*')
      extensions.push('mp4', 'webm', 'mov', 'avi', 'mkv')
      filterNames.push('Video')
    }

    return {
      acceptString: accept.join(','),
      tauriFilters: extensions.length > 0 ? [{ name: filterNames.join(' / '), extensions }] : [],
    }
  }, [caps.image, caps.pdf, caps.audio, caps.video])
  // State for menus
  const [variantMenuOpen, setVariantMenuOpen] = useState(false)

  // Refs
  const variantTriggerRef = useRef<HTMLButtonElement>(null)
  const variantMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const variantMenuFocusRef = useRef<'selected' | 'first' | 'last'>('selected')
  const variantMenuId = 'input-toolbar-variant-menu'

  const focusComposerInput = useCallback(() => {
    const input = inputContainerRef?.current?.querySelector<HTMLElement>(
      'textarea, input:not([type="file"]):not([disabled]), [contenteditable="true"]',
    )
    input?.focus()
  }, [inputContainerRef])

  const closeMenuToComposer = useCallback(
    (close: () => void) => {
      close()
      window.setTimeout(focusComposerInput, 0)
    },
    [focusComposerInput],
  )

  const focusMenuItem = useCallback((menu: HTMLDivElement | null, mode: 'selected' | 'first' | 'last') => {
    if (!menu) return

    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], button'))
    if (items.length === 0) return

    const selectedItem = menu.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')
    const target = mode === 'first' ? items[0] : mode === 'last' ? items[items.length - 1] : selectedItem ?? items[0]
    target?.focus()
  }, [])

  const focusRelativeToTrigger = useCallback((trigger: HTMLButtonElement | null, direction: 1 | -1) => {
    if (!trigger) return

    const focusables = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([type="file"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(element => {
      if (element.closest('[aria-hidden="true"]')) return false
      const style = window.getComputedStyle(element)
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
    })
    const currentIndex = focusables.findIndex(item => item === trigger)
    if (currentIndex === -1) return
    const nextIndex = currentIndex + direction
    focusables[nextIndex]?.focus()
  }, [])

  const isFocusableElement = useCallback((target: EventTarget | null) => {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    if (!element) return false
    const candidate = element.closest<HTMLElement>(
      'button:not([disabled]), [href], input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (!candidate) return false

    const style = window.getComputedStyle(candidate)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }, [])

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, menu: HTMLDivElement | null, onClose: () => void, trigger: HTMLButtonElement | null) => {
      const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], button') ?? [])
      if (items.length === 0) {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          trigger?.focus()
        }
        return
      }

      const currentIndex = items.findIndex(item => item === document.activeElement)
      const focusByIndex = (index: number) => items[index]?.focus()

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % items.length
        focusByIndex(nextIndex)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        const nextIndex = currentIndex === -1 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
        focusByIndex(nextIndex)
      } else if (event.key === 'Home') {
        event.preventDefault()
        focusByIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        focusByIndex(items.length - 1)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        trigger?.focus()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        onClose()
        window.setTimeout(() => {
          focusRelativeToTrigger(trigger, event.shiftKey ? -1 : 1)
        }, 0)
      }
    },
    [focusRelativeToTrigger],
  )

  // 文件选择器（Tauri 原生 / 浏览器 fallback）
  const handleFileClick = useCallback(async () => {
    if (useBrowserFileInput) {
      fileInputRef.current?.click()
      return
    }

    try {
      const [{ open }, { readFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ])

      const selected = await open({
        multiple: true,
        filters: tauriFilters,
        fileAccessMode: 'copy',
      })

      if (!selected) return

      const paths = Array.isArray(selected) ? selected : [selected]
      if (paths.length === 0) return

      const files: File[] = []
      for (const path of paths) {
        const fileName = path.split(/[\\/]/).pop() || 'file'
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const mime = extToMime(ext)

        const data = await readFile(path)
        const file = new File([data], fileName, { type: mime })
        files.push(file)
      }

      if (files.length > 0) {
        onFilesSelected(files)
      }
    } catch (err) {
      console.warn('[InputToolbar] File picker error:', err)
    }
  }, [onFilesSelected, tauriFilters, useBrowserFileInput])

  // Click outside logic
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        variantMenuOpen &&
        !variantMenuRef.current?.contains(e.target as Node) &&
        !variantTriggerRef.current?.contains(e.target as Node)
      ) {
        setVariantMenuOpen(false)
        if (!isFocusableElement(e.target)) {
          variantTriggerRef.current?.focus()
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [variantMenuOpen, isFocusableElement])

  useEffect(() => {
    if (!variantMenuOpen) return
    const timerId = window.setTimeout(() => {
      focusMenuItem(variantMenuRef.current, variantMenuFocusRef.current)
    }, 0)
    return () => clearTimeout(timerId)
  }, [variantMenuOpen, focusMenuItem])
  const activeDeliveryMode = deliveryMode === 'steer' && canSteer ? 'steer' : canFollowUp ? 'followUp' : 'steer'
  const deliveryLabel = activeDeliveryMode === 'steer' ? 'Steer' : 'Follow-up'
  const deliveryHint = activeDeliveryMode === 'steer' ? t('inputToolbar.steerHint') : t('inputToolbar.followUpHint')
  const canToggleDeliveryMode = canSteer && canFollowUp

  return (
    <div className="flex items-center justify-between px-3 pb-3 relative">
      {/* Left side: Model (mobile) + Agent + Variant selectors */}
      <div className={`flex items-center min-w-0 ${isCompact ? 'gap-1' : 'gap-2'}`}>
        {/* Model Selector — 移动端显示在最左边 */}
        {isCompact && onModelChange && (
          <ModelSelector
            ref={modelSelectorRef}
            models={models}
            selectedModelKey={selectedModelKey}
            onSelect={onModelChange}
            isLoading={modelsLoading}
            position="top"
            trigger="toolbar"
            constrainToRef={inputContainerRef}
          />
        )}

        {/* Variant Selector */}
        <AnimatedPresence show={variants.length > 0} className={isCompact ? 'shrink-0' : ''}>
          <div className="relative">
            <button
              ref={variantTriggerRef}
              type="button"
              onClick={() => {
                variantMenuFocusRef.current = 'selected'
                setVariantMenuOpen(!variantMenuOpen)
              }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  variantMenuFocusRef.current = e.key === 'ArrowUp' ? 'last' : 'first'
                  setVariantMenuOpen(true)
                }
              }}
              disabled={controlsDisabled}
              aria-haspopup="menu"
              aria-expanded={variantMenuOpen}
              aria-controls={variantMenuOpen ? variantMenuId : undefined}
              className="flex items-center gap-1.5 px-2 py-1.5 text-[length:var(--fs-base)] rounded-lg transition-all duration-150 hover:bg-bg-200 active:scale-95 cursor-pointer min-w-0 overflow-hidden w-full"
              title={
                selectedVariant
                  ? selectedVariant.charAt(0).toUpperCase() + selectedVariant.slice(1)
                  : t('inputToolbar.default')
              }
            >
              {/* 紧凑信息流隐藏 ThinkingIcon */}
              <span className={`text-text-400 shrink-0 ${isCompact ? 'hidden' : ''}`}>
                <ThinkingIcon />
              </span>
              <span className="text-[length:var(--fs-sm)] text-text-300 truncate">
                {selectedVariant
                  ? selectedVariant.charAt(0).toUpperCase() + selectedVariant.slice(1)
                  : t('inputToolbar.default')}
              </span>
              <span className={`text-text-400 shrink-0 ${isCompact ? 'hidden' : ''}`}>
                <ChevronDownIcon />
              </span>
            </button>

            <DropdownMenu
              triggerRef={variantTriggerRef}
              isOpen={variantMenuOpen}
              position="top"
              align="left"
              minWidth="auto"
              constrainToRef={inputContainerRef}
            >
              <div
                id={variantMenuId}
                ref={variantMenuRef}
                role="menu"
                aria-label={t('inputToolbar.variantMenu')}
                onKeyDown={event =>
                  handleMenuKeyDown(event, variantMenuRef.current, () => setVariantMenuOpen(false), variantTriggerRef.current)
                }
              >
                {variants.map(variant => (
                  <MenuItem
                    key={variant}
                    label={variant.charAt(0).toUpperCase() + variant.slice(1)}
                    icon={<ThinkingIcon />}
                    selected={selectedVariant === variant}
                    selectionRole="menuitemradio"
                    onClick={() => {
                      onVariantChange?.(variant)
                      closeMenuToComposer(() => setVariantMenuOpen(false))
                    }}
                  />
                ))}
              </div>
            </DropdownMenu>
          </div>
        </AnimatedPresence>

        <AnimatedPresence show={Boolean(isStreaming && (canSteer || canFollowUp))} className={isCompact ? 'shrink-0' : ''}>
          <div className="relative">
            <button
              type="button"
              disabled={controlsDisabled || !canToggleDeliveryMode}
              aria-label={`${t('inputToolbar.deliveryMode')}: ${deliveryLabel}`}
              aria-pressed={activeDeliveryMode === 'steer'}
              title={deliveryHint}
              onClick={() => {
                if (!canToggleDeliveryMode) return
                onDeliveryModeChange?.(activeDeliveryMode === 'steer' ? 'followUp' : 'steer')
              }}
              className="flex items-center gap-1.5 px-2 py-1.5 text-[length:var(--fs-base)] rounded-lg transition-all duration-150 hover:bg-bg-200 active:scale-95 cursor-pointer min-w-0 overflow-hidden w-full disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="text-[length:var(--fs-sm)] text-text-300 truncate">{deliveryLabel}</span>
            </button>
          </div>
        </AnimatedPresence>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-1">
        <AnimatedPresence show={supportsAnyFile}>
          <>
            {/* 浏览器模式下的隐藏文件输入 */}
            {useBrowserFileInput && (
              <input
                ref={fileInputRef}
                type="file"
                accept={acceptString}
                multiple
                className="hidden"
                onChange={e => {
                  onFilesSelected(Array.from(e.target.files ?? []))
                  e.currentTarget.value = ''
                }}
              />
            )}
            <IconButton aria-label={t('inputToolbar.attachFile')} disabled={controlsDisabled} onClick={handleFileClick}>
              <PaperclipIcon />
            </IconButton>
          </>
        </AnimatedPresence>
        {/* 停止按钮条件：输入框为空（不可发送）且（压缩中 / 流式中 / 会话活跃）。
            只要输入框有内容（canSend），就显示发送按钮——停止按钮只在
            没有可发送内容时出现（中止压缩/生成）。 */}
        {(!canSend && (isCompacting || isStreaming || sessionActive)) && !isSending ? (
          <IconButton aria-label={t('inputToolbar.stopGeneration')} variant="solid" onClick={onAbort}>
            <StopIcon />
          </IconButton>
        ) : (
          <IconButton
            aria-label={isSending ? t('inputToolbar.sendingMessage') : t('inputToolbar.sendMessage')}
            variant="solid"
            disabled={!canSend || isSending}
            onClick={onSend}
          >
            <SendIcon />
          </IconButton>
        )}
      </div>
    </div>
  )
}
