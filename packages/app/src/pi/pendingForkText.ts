/**
 * Fork 的 selectedText 传递带：树面板/消息菜单 fork('before') 之后，
 * 目标会话可能还没挂载，先把 SDK 提取的用户消息文本按目标 sessionId
 * 存下，PiChatPane 进入该会话时取走灌进输入框（pi TUI parity）。
 */
const pending = new Map<string, string>()

export function stashForkText(sessionId: string, text: string): void {
  if (!text.trim()) return
  pending.set(sessionId, text)
}

export function takeForkText(sessionId: string): string | undefined {
  const text = pending.get(sessionId)
  if (text !== undefined) pending.delete(sessionId)
  return text
}
