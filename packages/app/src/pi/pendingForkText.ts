/**
 * Fork 的 selectedText 传递带：树面板/消息菜单 fork('before') 之后，
 * 目标会话可能还没挂载，先把 SDK 提取的用户消息文本按目标 sessionId
 * 存下，PiChatPane 进入该会话时取走灌进输入框（pi TUI parity）。
 * 用 sessionStorage 而不是纯内存：页面刷新（或 vite 整页重载）后
 * 进入 fork 出的会话，原文依然能带回输入框。
 */
const KEY_PREFIX = 'piui-fork-seed:'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function stashForkText(sessionId: string, text: string): void {
  if (!text.trim()) return
  try {
    storage()?.setItem(KEY_PREFIX + sessionId, text)
  } catch {
    /* 存储不可用时静默降级为不带回 */
  }
}

export function takeForkText(sessionId: string): string | undefined {
  const store = storage()
  if (!store) return undefined
  const text = store.getItem(KEY_PREFIX + sessionId)
  if (text !== null) store.removeItem(KEY_PREFIX + sessionId)
  return text ?? undefined
}
