import { createContext } from 'react'

export const JsonDraftErrorContext = createContext<(id: string, invalid: boolean) => void>(() => {})
export const DraftErrorContext = createContext<(id: string, invalid: boolean) => void>(() => {})
export const DraftNavigationContext = createContext<() => boolean>(() => true)
