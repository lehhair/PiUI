import { useState, useRef, useCallback } from 'react'
import { useClickOutside } from './useClickOutside'

interface UseDropdownOptions {
  onOpen?: () => void
  onClose?: () => void
}

/**
 * Hook to manage dropdown state and behavior
 */
export function useDropdown<T extends HTMLElement = HTMLDivElement>(options: UseDropdownOptions = {}) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const open = useCallback(() => {
    setIsOpen(true)
    options.onOpen?.()
  }, [options])

  const close = useCallback(() => {
    setIsOpen(false)
    options.onClose?.()
  }, [options])

  const toggle = useCallback(() => {
    if (isOpen) {
      close()
    } else {
      open()
    }
  }, [isOpen, open, close])

  const menuRef = useClickOutside<T>(() => {
    // Check if click was on the trigger button
    close()
  }, isOpen)

  return {
    isOpen,
    open,
    close,
    toggle,
    triggerRef,
    menuRef,
  }
}
