// ============================================
// PiUI host surface types — 原生形状，无 OCUI 兼容层
// ============================================

/** 当前/已保存的工作区（由 PiUI server 的 workspace 语义构建） */
export interface HostProject {
  id: string
  name: string
  /** 工作区绝对路径 */
  path: string
  /** git 仓库根（存在即视为 git 工作区） */
  gitRoot?: string
}
