import { UnsupportedPiCapabilityError } from './errors'
import type { Worktree, WorktreeCreateInput, WorktreeRemoveInput, WorktreeResetInput } from '../types/api/worktree'

export async function listWorktrees(_directory?: string): Promise<string[]> {
  return []
}

function unsupported(): never {
  throw new UnsupportedPiCapabilityError('Git worktree management')
}

export async function createWorktree(_params: WorktreeCreateInput, _directory?: string): Promise<Worktree> {
  return unsupported()
}

export async function removeWorktree(_params: WorktreeRemoveInput, _directory?: string): Promise<boolean> {
  return unsupported()
}

export async function resetWorktree(_params: WorktreeResetInput, _directory?: string): Promise<boolean> {
  return unsupported()
}
