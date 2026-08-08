import { useCallback, useContext } from 'react'
import { layoutStore, useLayoutStore } from '../store/layoutStore'
import { DirectoryContext, type DirectoryContextValue, type SavedDirectory } from './DirectoryContext.shared'

export function useDirectory(): DirectoryContextValue {
  const context = useContext(DirectoryContext)
  if (!context) {
    throw new Error('useDirectory must be used within a DirectoryProvider')
  }
  return context
}

export function useCurrentDirectory(): string | undefined {
  const { currentDirectory } = useDirectory()
  return currentDirectory
}

export function useSavedDirectories(): SavedDirectory[] {
  const { savedDirectories } = useDirectory()
  return savedDirectories
}

export function useSidebarExpanded(): [boolean, (expanded: boolean) => void] {
  const { sidebarExpanded } = useLayoutStore()
  const setSidebarExpanded = useCallback((expanded: boolean) => {
    layoutStore.setSidebarExpanded(expanded)
  }, [])
  return [sidebarExpanded, setSidebarExpanded]
}
