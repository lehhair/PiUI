import { createContext } from 'react'

export interface SavedDirectory {
  path: string
  name: string
  addedAt: number
}

export interface DirectoryContextValue {
  currentDirectory: string | undefined
  setCurrentDirectory: (directory: string | undefined) => void
  savedDirectories: SavedDirectory[]
  addDirectory: (path: string) => void
  removeDirectory: (path: string) => void
  reorderDirectories: (draggedPath: string, targetPath: string) => void
  sidebarExpanded: boolean
  setSidebarExpanded: (expanded: boolean) => void
  recentProjects: Record<string, number>
}

export const DirectoryContext = createContext<DirectoryContextValue | null>(null)
