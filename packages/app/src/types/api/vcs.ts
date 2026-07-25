export interface VcsInfo { branch?: string; default_branch?: string; root?: string; upstream?: string; ahead?: number; behind?: number }
export type VcsDiffMode = 'staged' | 'unstaged' | 'all' | 'git' | 'branch'
