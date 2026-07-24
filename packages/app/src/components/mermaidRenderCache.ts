const MERMAID_CACHE_MAX = 64

const svgCache = new Map<string, string>()
const pendingRenders = new Map<string, Promise<string>>()
let renderQueue: Promise<void> = Promise.resolve()

export function getCachedMermaidSvg(key: string) {
  return svgCache.get(key)
}

export async function getOrRenderMermaidSvg(key: string, render: () => Promise<string>) {
  const cached = svgCache.get(key)
  if (cached !== undefined) return cached

  const pending = pendingRenders.get(key)
  if (pending) return pending

  const promise = renderQueue.then(render, render).then(svg => {
    if (svgCache.size >= MERMAID_CACHE_MAX) {
      const firstKey = svgCache.keys().next().value
      if (firstKey !== undefined) svgCache.delete(firstKey)
    }
    svgCache.set(key, svg)
    return svg
  })
  renderQueue = promise.then(
    () => undefined,
    () => undefined,
  )

  pendingRenders.set(key, promise)
  try {
    return await promise
  } finally {
    pendingRenders.delete(key)
  }
}

export function clearMermaidRenderCache() {
  svgCache.clear()
  pendingRenders.clear()
}
