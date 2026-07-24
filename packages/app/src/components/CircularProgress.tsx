// ============================================
// CircularProgress - 环形进度指示器
// ============================================

interface CircularProgressProps {
  /** 进度值 0-1 */
  progress: number
  /** 整体尺寸 (px) */
  size: number
  /** 描边宽度，默认 3 */
  strokeWidth?: number
  /** 轨道 className（通过 text-xxx 控制颜色） */
  trackClassName?: string
  /** 进度弧 className */
  progressClassName?: string
  /** SVG 外层 className */
  className?: string
}

export function CircularProgress({
  progress,
  size,
  strokeWidth = 3,
  trackClassName = 'text-text-500/30',
  progressClassName = 'text-accent-main-100',
  className = '',
}: CircularProgressProps) {
  const r = (size - strokeWidth) / 2
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.min(Math.max(progress, 0), 1))

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`-rotate-90 ${className}`}
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className={trackClassName}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        className={`transition-all duration-500 ease-out ${progressClassName}`}
      />
    </svg>
  )
}
