export interface ProjectIcon { url?: string; color?: string }
export type ProjectCommands = Record<string, string>
export interface Project {
  id: string
  worktree: string
  name?: string
  icon?: ProjectIcon
  commands?: ProjectCommands
  time?: { created?: number; updated?: number }
  vcs?: 'git' | string
}
export interface ProjectUpdateParams { name?: string; icon?: ProjectIcon; commands?: ProjectCommands }
export interface PathResponse { home: string; state: string; config: string; worktree: string; directory: string }
