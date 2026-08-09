/**
 * 流渲染性能埋点（开发诊断用）
 *
 * 通过 URL 参数 `?piuiPerf=1` 启用。启用后对关键渲染路径打
 * performance.mark，可在 DevTools Performance 面板或
 * window.__piuiPerfReport() 中查看每一环耗时。
 *
 * 生产构建下完全无开销（空函数）。
 */

const enabled = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('piuiPerf')

// 各 mark 的上次时间（O(1) 间隔计算；performance.getEntriesByName 会随
// mark 数量线性增长，长流式会话里每 token 一次会拖慢被测路径本身）
const lastMarkAt = new Map<string, number>()

/** 打一个 mark；返回自上次同名 mark 至今的耗时（ms）或 null */
export function perfMark(name: string): number | null {
  if (!enabled) return null
  const now = performance.now()
  const prev = lastMarkAt.get(name)
  lastMarkAt.set(name, now)
  try {
    performance.mark(name)
  } catch {
    // performance.mark 在部分环境（jsdom）不可用；间隔计算不受影响
  }
  return prev === undefined ? null : now - prev
}

type Agg = { count: number; totalMs: number; maxMs: number; avgMs: number }

function agg(measures: { duration: number }[]): Agg {
  if (measures.length === 0) return { count: 0, totalMs: 0, maxMs: 0, avgMs: 0 }
  let totalMs = 0
  let maxMs = 0
  for (const m of measures) {
    totalMs += m.duration
    if (m.duration > maxMs) maxMs = m.duration
  }
  return { count: measures.length, totalMs, maxMs, avgMs: totalMs / measures.length }
}

/** 输出完整报告：打印每个埋点环节的耗时统计 */
export function perfReport(): void {
  if (!enabled) {
    console.warn('[perf] 未启用：请以 ?piuiPerf=1 打开页面')
    return
  }

  const groups: Array<[string, string, string]> = [
    ['事件→数据层', 'piui:event-message-update', 'piui:event-message-update'],
    ['timeline 构建', 'piui:build-timeline', 'piui:build-timeline:end'],
    ['markdown 解析', 'piui:render-markdown', 'piui:render-markdown:end'],
    ['行测量', 'piui:measure-row', 'piui:measure-row:end'],
  ]

  const lines = ['', '═══ PiUI 流渲染埋点报告 ═══']
  for (const [label, startName, endName] of groups) {
    const starts = performance.getEntriesByName(startName) as PerformanceMark[]
    const ends = performance.getEntriesByName(endName) as PerformanceMark[]
    // 相邻同名 mark 间隔：event/measure 用自身间隔，build/render 用 start→end 对
    const measures: { duration: number }[] = []
    if (startName === endName) {
      for (let i = 1; i < starts.length; i++) {
        measures.push({ duration: Math.max(0, starts[i].startTime - starts[i - 1].startTime) })
      }
    } else {
      const n = Math.min(starts.length, ends.length)
      for (let i = 0; i < n; i++) {
        measures.push({ duration: Math.max(0, ends[i].startTime - starts[i].startTime) })
      }
    }
    const s = agg(measures)
    lines.push(
      s.count === 0
        ? `  ${label}: (无采样)`
        : `  ${label}: ${s.count} 次 | 累计 ${s.totalMs.toFixed(1)}ms | 峰值 ${s.maxMs.toFixed(2)}ms | 平均 ${s.avgMs.toFixed(2)}ms`,
    )
  }

  // 组件渲染耗时
  const renderStats = perfRenderStats()
  const renderNames = Object.keys(renderStats)
  if (renderNames.length > 0) {
    lines.push('')
    lines.push('--- 组件渲染耗时 (top 8) ---')
    renderNames
      .sort((a, b) => renderStats[b].totalMs - renderStats[a].totalMs)
      .slice(0, 8)
      .forEach(name => {
        const s = renderStats[name]
        lines.push(`  ${name}: ${s.count} 次 | 累计 ${s.totalMs.toFixed(1)}ms | 峰值 ${s.maxMs.toFixed(1)}ms | 平均 ${(s.totalMs / s.count).toFixed(2)}ms`)
      })
  }

  // 事件→行测量完成总耗时（近一次）
  const lastEvent = performance.getEntriesByName('piui:event-message-update').at(-1) as PerformanceMark | undefined
  const lastRow = performance.getEntriesByName('piui:measure-row:end').at(-1) as PerformanceMark | undefined
  if (lastEvent && lastRow && lastRow.startTime >= lastEvent.startTime) {
    lines.push(`  事件→行测量完成(近一次): ${(lastRow.startTime - lastEvent.startTime).toFixed(2)}ms`)
  }
  lines.push('═══════════════════════')
  console.log(lines.join('\n'))
}

// ─── 组件渲染耗时统计（?piuiPerf=1 时收集） ───

const renderStats = new Map<string, { count: number; totalMs: number; maxMs: number }>()

/** 暴露到 window，方便 console 直接调用 */
if (enabled && typeof window !== 'undefined') {
  ;(window as unknown as { __piuiPerfReport: () => void }).__piuiPerfReport = perfReport
  ;(window as unknown as { __piuiPerfReset: () => void }).__piuiPerfReset = () => {
    performance.clearMarks()
    performance.clearMeasures()
    lastMarkAt.clear()
    renderStats.clear()
    console.log('[perf] 已清空埋点与渲染统计——发一条消息后重新调用 window.__piuiPerfReport()')
  }
}

export function isPerfEnabled(): boolean {
  return enabled
}

/** 记录一次组件渲染耗时（组件函数体开始/结束各调一次，或传实际耗时） */
export function perfRecordRender(component: string, ms: number): void {
  if (!enabled) return
  const s = renderStats.get(component) ?? { count: 0, totalMs: 0, maxMs: 0 }
  s.count++
  s.totalMs += ms
  if (ms > s.maxMs) s.maxMs = ms
  renderStats.set(component, s)
}

/** 读组件渲染统计 */
export function perfRenderStats(): Record<string, { count: number; totalMs: number; maxMs: number }> {
  return Object.fromEntries(renderStats)
}
