// Best-effort haptic tap: Android native bridge first, W3C Vibration API fallback.

export function hapticTap(ms = 8): void {
  try {
    const b = (window as unknown as { __piui_android?: { vibrate?: (n: number) => void } }).__piui_android?.vibrate
    if (b) return b(ms)
    navigator.vibrate?.(ms)
  } catch { /* ignore */ }
}
