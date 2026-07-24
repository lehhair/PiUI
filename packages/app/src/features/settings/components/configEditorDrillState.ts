import { createContext, useContext } from 'react'
import type { ValidationDrillTarget } from './configEditorValidation'

export type DrillEntry = { id: string; title: string }

export type DrillState = {
  stack: DrillEntry[]
  push: (entry: DrillEntry) => void
  back: (toIndex: number) => void
  replace: (index: number, entry: DrillEntry) => void
}

export const DrillContext = createContext<DrillState | null>(null)
export const ValidationDrillTargetContext = createContext<ValidationDrillTarget | null>(null)
export const DrillDepthContext = createContext(0)

export function useDrillState(): DrillState {
  const api = useContext(DrillContext)
  if (!api) throw new Error('useDrill must be used inside <Drill>')
  return api
}

export function useDrillContainer() {
  const state = useDrillState()
  const depth = useContext(DrillDepthContext)
  const activeChild = state.stack[depth] ?? null
  const enter = (entry: DrillEntry) => {
    state.back(depth)
    state.push(entry)
  }
  return { activeChildId: activeChild?.id ?? null, enter, depth }
}
