export interface Worktree { id?: string; directory: string; branch?: string; name?: string }
export interface WorktreeCreateInput { branch?: string; name?: string }
export interface WorktreeRemoveInput { directory: string }
export interface WorktreeResetInput { directory: string }
