import { useEffect, useRef } from 'react'

/** 块级高度变化阈值：>= 此值（约一行行高）走平滑过渡，否则即时同步 */
const HEIGHT_SMOOTH_THRESHOLD = 24

/**
 * SmoothHeight - 内容高度变化时平滑过渡
 *
 * 始终渲染同一 DOM 结构（普通 div），不因 isActive 切换重建子树。
 * isActive=true 时：ResizeObserver 读 inner 高度，用 CSS transition 连续追 outer 高度
 * isActive=false 时：零开销（无 ResizeObserver、无动画）
 *
 * 不用 motion animate().stop()+restart：流式时每帧重启 easeOut 会让整块（含已登场内容）发颤。
 * CSS transition 中途改目标会从当前计算值接着插值，已登场区域更稳。
 *
 * 按变化幅度分流：
 * - 块级大变化（新代码块/工具块/整段换行，>= HEIGHT_SMOOTH_THRESHOLD）：
 *   transition 平滑展开/收起，保留丝滑观感
 * - 逐字/单行小增长（流式 token 刷新）：同帧即时同步 —— 增量小本来就顺滑，
 *   且避免 transition 追赶滞后让 inner 溢出盖住下方内容（重叠/错位）
 */
export function SmoothHeight({
  isActive,
  children,
  className,
}: {
  isActive: boolean
  children: React.ReactNode
  className?: string
}) {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner || !isActive) {
      if (outer) {
        outer.style.height = ''
        outer.style.clipPath = ''
        outer.style.transition = ''
      }
      return
    }

    // 系统设置减少动效：不锁高，内容自然撑开
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      outer.style.height = ''
      outer.style.clipPath = ''
      outer.style.transition = ''
      return
    }

    // 锁定 outer 为当前内容高度 — 之后内容增长不会自动撑开 outer，
    // 必须改 height + CSS transition 驱动 outer 增长
    const initial = inner.scrollHeight
    outer.style.height = `${initial}px`
    // 只裁切垂直方向，水平方向留出空间让 icon 光晕等视觉效果溢出
    outer.style.clipPath = 'inset(0 -100% 0 -100%)'
    // linear 短过渡：流式高频改目标时，浏览器从当前值接着插值，不 stop/restart
    outer.style.transition = 'height 120ms linear'

    // rAF 批处理：流式期间 ResizeObserver 每帧可能触发多次回调，
    // 同帧内合并为一次 scrollHeight 读取 + 设 height，避免 layout thrash
    let updateRafId: number | null = null
    let lastApplied = initial

    const applyHeight = (target: number) => {
      const delta = Math.abs(target - lastApplied)
      if (delta < 0.5) return
      // 块级大变化（新代码块/工具块/整段换行）→ 平滑过渡，保留丝滑观感；
      // 逐字/单行小增长 → 即时同步（增量小本就顺滑，且零滞后不重叠）
      outer.style.transition = delta >= HEIGHT_SMOOTH_THRESHOLD ? 'height 120ms linear' : 'none'
      lastApplied = target
      outer.style.height = `${target}px`
    }

    const update = () => {
      if (updateRafId !== null) return
      updateRafId = requestAnimationFrame(() => {
        updateRafId = null
        applyHeight(inner.scrollHeight)
      })
    }

    const ro = new ResizeObserver(update)
    ro.observe(inner)

    return () => {
      ro.disconnect()
      if (updateRafId !== null) cancelAnimationFrame(updateRafId)
    }
  }, [isActive])

  return (
    <div ref={outerRef} className={className}>
      <div ref={innerRef}>{children}</div>
    </div>
  )
}
