import { useEffect, useState } from 'react'
import { EXPAND_MOTION } from '../constants/expandMotion'

export interface DelayedRenderOptions {
  /**
   * 展开时延迟挂载内容（ms）。
   * 用于「先画 header / 折叠条，再挂 body」，避免首帧 header+body 一起长高。
   * 收起延迟仍用 delayMs。
   */
  mountDelayMs?: number
}

/**
 * 折叠内容的延迟挂载 / 延迟卸载。
 *
 * - show=true 且 mountDelayMs=0：当帧即可渲染（兼容原行为）
 * - show=true 且 mountDelayMs>0：延迟后再挂
 * - show=false：delayMs 后再卸，方便 grid 收起动画跑完
 */
export function useDelayedRender(
  show: boolean,
  delayMs: number = EXPAND_MOTION.unmountDelayMs,
  options?: DelayedRenderOptions,
): boolean {
  const mountDelayMs = options?.mountDelayMs ?? 0
  const [shouldRender, setShouldRender] = useState(() => show && mountDelayMs <= 0)

  // 展开（无 mount 延迟）时同步 shouldRender state：收起时靠它做延迟卸载
  // （grid 收起动画跑完再卸 DOM）。渲染期条件 setState 是 React 官方
  // 「adjusting state during render」模式——只设一次，不产生循环。
  if (show && mountDelayMs <= 0 && !shouldRender) {
    setShouldRender(true)
  }

  useEffect(() => {
    if (show) {
      // mountDelayMs>0 时延迟挂载；<=0 已由渲染期同步（见上）
      if (mountDelayMs > 0) {
        const timer = window.setTimeout(() => setShouldRender(true), mountDelayMs)
        return () => clearTimeout(timer)
      }
      return
    }

    const timer = window.setTimeout(() => setShouldRender(false), delayMs)
    return () => clearTimeout(timer)
  }, [show, delayMs, mountDelayMs])

  // 无 mount 延迟时展开当帧可见；有延迟时只信 shouldRender
  if (show && mountDelayMs <= 0) return true
  return shouldRender
}
