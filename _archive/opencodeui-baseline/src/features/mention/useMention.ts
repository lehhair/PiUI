// ============================================
// useMention Hook
// 管理 mention 状态和编辑器交互
// ============================================

import { useState, useRef, useCallback } from 'react'
import type { MentionItem, MentionMenuState, MentionConfig } from './types'
import { detectMentionTrigger, toAbsolutePath } from './utils'
import { createMentionElement } from './createMentionElement'

interface UseMentionOptions extends MentionConfig {
  /** 编辑器元素的 ref */
  editorRef: React.RefObject<HTMLDivElement | null>
  /** 文本变化回调 */
  onTextChange?: (text: string) => void
  /** 菜单关闭回调 */
  onMenuClose?: () => void
}

interface UseMentionReturn {
  /** 菜单状态 */
  menuState: MentionMenuState
  /** 已选择的 mentions */
  mentions: MentionItem[]
  /** 打开菜单 */
  openMenu: (query: string, startIndex: number) => void
  /** 关闭菜单 */
  closeMenu: () => void
  /** 处理输入事件 */
  handleInput: (e: React.FormEvent<HTMLDivElement>) => string
  /** 处理 mention 选择 */
  handleSelect: (item: MentionItem) => void
  /** 重置状态 */
  reset: () => void
  /** 获取序列化的文本（包含 mention 标记） */
  getSerializedText: () => string
}

/**
 * useMention - 管理 mention 系统的核心 hook
 */
export function useMention(options: UseMentionOptions): UseMentionReturn {
  const {
    editorRef,
    trigger = '@',
    rootPath = '',
    // allowMultiple = true, // TODO: implement single mention mode if needed
    onTextChange,
    onMenuClose,
  } = options

  // 菜单状态
  const [menuState, setMenuState] = useState<MentionMenuState>({
    isOpen: false,
    query: '',
    startIndex: -1,
  })

  // 已选择的 mentions
  const [mentions, setMentions] = useState<MentionItem[]>([])

  // 内部文本状态（包含 mention 标记）
  const serializedTextRef = useRef('')

  // 打开菜单
  const openMenu = useCallback((query: string, startIndex: number) => {
    setMenuState({
      isOpen: true,
      query,
      startIndex,
    })
  }, [])

  // 关闭菜单
  const closeMenu = useCallback(() => {
    setMenuState(prev => ({ ...prev, isOpen: false }))
    onMenuClose?.()
  }, [onMenuClose])

  // 处理输入事件
  const handleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>): string => {
      const editor = e.currentTarget

      // 获取纯文本（不包含 mention span 的 data）
      const plainText = getPlainText(editor)

      // 获取序列化文本（包含 mention 标记）
      const serializedText = getSerializedText(editor)
      serializedTextRef.current = serializedText
      onTextChange?.(serializedText)

      // 获取光标位置
      const cursorPos = getCursorPosition(editor)

      // 检测 @ 触发
      const triggerResult = detectMentionTrigger(plainText, cursorPos, trigger)

      if (triggerResult) {
        openMenu(triggerResult.query, triggerResult.startIndex)
      } else {
        if (menuState.isOpen) {
          closeMenu()
        }
      }

      return serializedText
    },
    [trigger, menuState.isOpen, openMenu, closeMenu, onTextChange],
  )

  // 处理 mention 选择
  const handleSelect = useCallback(
    (item: MentionItem) => {
      const editor = editorRef.current
      if (!editor) return

      // 如果有 rootPath，确保使用绝对路径
      const finalItem: MentionItem = {
        ...item,
        value: item.type !== 'agent' && rootPath ? toAbsolutePath(item.value, rootPath) : item.value,
      }

      // 获取当前纯文本和光标位置
      const plainText = getPlainText(editor)

      // 找到要替换的范围：从 @ 到当前光标位置
      const beforeAt = plainText.slice(0, menuState.startIndex)
      const afterQuery = plainText.slice(menuState.startIndex + 1 + menuState.query.length)

      // 重建编辑器内容
      rebuildEditorContent(editor, beforeAt, finalItem, afterQuery, mentions)

      // 更新序列化文本
      serializedTextRef.current = getSerializedText(editor)
      onTextChange?.(serializedTextRef.current)

      // 保存 mention
      setMentions(prev => [...prev, finalItem])

      // 关闭菜单
      closeMenu()

      // 聚焦并移动光标
      requestAnimationFrame(() => {
        editor.focus()
        moveCursorToEnd(editor)
      })
    },
    [editorRef, menuState, rootPath, mentions, closeMenu, onTextChange],
  )

  // 重置状态
  const reset = useCallback(() => {
    setMenuState({ isOpen: false, query: '', startIndex: -1 })
    setMentions([])
    serializedTextRef.current = ''
    if (editorRef.current) {
      editorRef.current.innerHTML = ''
    }
  }, [editorRef])

  // 获取序列化的文本
  const getSerializedTextFn = useCallback(() => {
    if (editorRef.current) {
      return getSerializedText(editorRef.current)
    }
    return serializedTextRef.current
  }, [editorRef])

  return {
    menuState,
    mentions,
    openMenu,
    closeMenu,
    handleInput,
    handleSelect,
    reset,
    getSerializedText: getSerializedTextFn,
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * 获取编辑器的纯文本（mention 显示为其 label）
 */
function getPlainText(editor: HTMLElement): string {
  let text = ''

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.classList.contains('mention-tag')) {
        // Mention 标签，使用其显示文本
        text += el.textContent || ''
      } else {
        // 递归处理子节点
        el.childNodes.forEach(walk)
      }
    }
  }

  editor.childNodes.forEach(walk)
  return text
}

/**
 * 获取编辑器的序列化文本（mention 转为 [[type:value]] 格式）
 */
function getSerializedText(editor: HTMLElement): string {
  let text = ''

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || ''
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.classList.contains('mention-tag')) {
        // Mention 标签，序列化
        const type = el.dataset.mentionType
        const value = el.dataset.mentionValue
        if (type && value) {
          text += `[[${type}:${value}]]`
        }
      } else {
        // 递归处理子节点
        el.childNodes.forEach(walk)
      }
    }
  }

  editor.childNodes.forEach(walk)
  return text
}

/**
 * 获取光标在纯文本中的位置
 */
function getCursorPosition(editor: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0

  const range = selection.getRangeAt(0)
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(editor)
  preCaretRange.setEnd(range.endContainer, range.endOffset)

  // 计算纯文本位置
  let position = 0
  const walk = (node: Node): boolean => {
    if (node === range.endContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        position += range.endOffset
      }
      return true // 找到了
    }

    if (node.nodeType === Node.TEXT_NODE) {
      position += node.textContent?.length || 0
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.classList.contains('mention-tag')) {
        position += el.textContent?.length || 0
      } else {
        for (const child of Array.from(el.childNodes)) {
          if (walk(child)) return true
        }
      }
    }
    return false
  }

  for (const child of Array.from(editor.childNodes)) {
    if (walk(child)) break
  }

  return position
}

/**
 * 重建编辑器内容
 */
function rebuildEditorContent(
  editor: HTMLElement,
  beforeText: string,
  newMention: MentionItem,
  afterText: string,
  _existingMentions: MentionItem[],
): void {
  // 保存现有的 mention spans
  const mentionSpans: HTMLSpanElement[] = []
  editor.querySelectorAll('.mention-tag').forEach((span: Element) => {
    mentionSpans.push(span.cloneNode(true) as HTMLSpanElement)
  })

  // 清空编辑器
  editor.innerHTML = ''

  // 添加 @ 之前的文本
  if (beforeText) {
    editor.appendChild(document.createTextNode(beforeText))
  }

  // 创建新的 mention 元素
  const { element: mentionSpan } = createMentionElement(newMention)
  // 注意：这里不需要调用 cleanup，因为 contentEditable 编辑器会在内容被替换时自动移除 DOM 元素
  // 事件监听器会随着 DOM 元素被 GC 一起被清理
  editor.appendChild(mentionSpan)

  // 添加空格和后续文本
  const afterContent = ' ' + afterText.trimStart()
  editor.appendChild(document.createTextNode(afterContent))
}

/**
 * 移动光标到编辑器末尾
 */
function moveCursorToEnd(editor: HTMLElement): void {
  const lastChild = editor.lastChild
  if (!lastChild) return

  const range = document.createRange()
  const sel = window.getSelection()

  if (lastChild.nodeType === Node.TEXT_NODE) {
    range.setStart(lastChild, lastChild.textContent?.length || 0)
  } else {
    range.setStartAfter(lastChild)
  }

  range.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(range)
}
