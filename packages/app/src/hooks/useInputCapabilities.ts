import { useEffect, useState } from 'react'

const CAN_HOVER_QUERY = '((hover: hover) and (pointer: fine)), ((any-hover: hover) and (any-pointer: fine))'
const COARSE_POINTER_QUERY = '(pointer: coarse), (any-pointer: coarse)'

export interface InputCapabilities {
  canHover: boolean
  hasCoarsePointer: boolean
  hasTouch: boolean
  preferTouchUi: boolean
}

function getMatchMediaMatches(query: string) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  return window.matchMedia(query).matches
}

export function getInputCapabilities(): InputCapabilities {
  const canHover = getMatchMediaMatches(CAN_HOVER_QUERY)
  const hasCoarsePointer = getMatchMediaMatches(COARSE_POINTER_QUERY)
  const hasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0
  const preferTouchUi = (hasCoarsePointer || hasTouch) && !canHover

  return {
    canHover,
    hasCoarsePointer,
    hasTouch,
    preferTouchUi,
  }
}

export function useInputCapabilities() {
  const [capabilities, setCapabilities] = useState<InputCapabilities>(getInputCapabilities)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    const canHoverMediaQuery = window.matchMedia(CAN_HOVER_QUERY)
    const coarsePointerMediaQuery = window.matchMedia(COARSE_POINTER_QUERY)
    const handleChange = () => {
      setCapabilities(getInputCapabilities())
    }

    handleChange()

    if (typeof canHoverMediaQuery.addEventListener === 'function') {
      canHoverMediaQuery.addEventListener('change', handleChange)
      coarsePointerMediaQuery.addEventListener('change', handleChange)
    } else {
      canHoverMediaQuery.addListener(handleChange)
      coarsePointerMediaQuery.addListener(handleChange)
    }

    window.addEventListener('pointerdown', handleChange, { passive: true })

    return () => {
      if (typeof canHoverMediaQuery.removeEventListener === 'function') {
        canHoverMediaQuery.removeEventListener('change', handleChange)
        coarsePointerMediaQuery.removeEventListener('change', handleChange)
      } else {
        canHoverMediaQuery.removeListener(handleChange)
        coarsePointerMediaQuery.removeListener(handleChange)
      }

      window.removeEventListener('pointerdown', handleChange)
    }
  }, [])

  return capabilities
}
