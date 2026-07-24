import { useEffect, useState } from 'react'

export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return

    const frameId = requestAnimationFrame(() => setNow(Date.now()))
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => {
      cancelAnimationFrame(frameId)
      window.clearInterval(timer)
    }
  }, [enabled, intervalMs])

  return now
}
