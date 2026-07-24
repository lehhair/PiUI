import { useEffect, type RefObject } from 'react'
import { getInternalDragSnapshot, subscribeInternalDrag, type InternalDragPayload } from '../lib/internalDragCore'

type Axis = 'x' | 'y'

interface UseDragEdgeAutoScrollOptions {
  axis?: Axis
  edgeSize?: number
  maxSpeed?: number
  payloadKind: InternalDragPayload['kind']
}

function getSpeed(distanceToEdge: number, edgeSize: number, maxSpeed: number) {
  if (distanceToEdge >= edgeSize) return 0
  const strength = 1 - Math.max(distanceToEdge, 0) / edgeSize
  return Math.ceil(strength * maxSpeed)
}

export function useDragEdgeAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  { axis = 'x', edgeSize = 36, maxSpeed = 18, payloadKind }: UseDragEdgeAutoScrollOptions,
) {
  useEffect(() => {
    let frame: number | null = null
    let speed = 0

    const stop = () => {
      speed = 0
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
    }

    const tick = () => {
      const container = containerRef.current
      if (!container || speed === 0) {
        frame = null
        return
      }

      if (axis === 'x') {
        container.scrollLeft += speed
      } else {
        container.scrollTop += speed
      }

      frame = requestAnimationFrame(tick)
    }

    const update = () => {
      const active = getInternalDragSnapshot().active
      const container = containerRef.current
      if (!active || !container || active.payload.kind !== payloadKind) {
        stop()
        return
      }

      const rect = container.getBoundingClientRect()
      const point = axis === 'x' ? active.current.x : active.current.y
      const start = axis === 'x' ? rect.left : rect.top
      const end = axis === 'x' ? rect.right : rect.bottom

      if (point < start || point > end) {
        stop()
        return
      }

      const prevSpeed = speed
      const before = getSpeed(point - start, edgeSize, maxSpeed)
      const after = getSpeed(end - point, edgeSize, maxSpeed)
      speed = after - before

      if (speed === 0) {
        stop()
      } else if (prevSpeed === 0 && frame === null) {
        frame = requestAnimationFrame(tick)
      }
    }

    const unsubscribe = subscribeInternalDrag(update)

    return () => {
      unsubscribe()
      stop()
    }
  }, [axis, containerRef, edgeSize, maxSpeed, payloadKind])
}
