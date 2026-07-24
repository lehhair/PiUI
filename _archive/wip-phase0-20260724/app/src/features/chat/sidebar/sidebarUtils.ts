/** 获取路径的父目录部分（用于显示项目位置） */
export function getParentPath(fullPath: string): string {
  // 处理 Windows 和 Unix 路径
  const sep = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(sep)
  // 移除最后一个部分（文件夹名本身）
  parts.pop()
  if (parts.length === 0) return sep
  // Windows: 保留盘符，Unix: 保留开头的 /
  const parent = parts.join(sep)
  return parent || sep
}

/** 格式化通知时间戳为相对时间 */
export function formatNotificationTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3600_000)}h ago`
}
