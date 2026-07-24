/**
 * 全局折叠展开动效 token
 * hooks / message 共用，避免 feature 反向依赖 hooks 里的 class 字符串
 */
export const EXPAND_MOTION = {
  durationMs: 300,
  /** 略长于 duration，保证收起动画跑完再卸 DOM */
  unmountDelayMs: 320,
  gridTransition: 'transition-[grid-template-rows] duration-300 ease-in-out',
  gridFadeTransition: 'transition-[grid-template-rows,opacity] duration-300 ease-out',
  chevronTransition: 'transition-transform duration-300',
  clipPath: 'inset(0 -100% 0 -100%)' as const,
} as const
