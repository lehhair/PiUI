import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { PiTimelinePageV1, TimelineItemV1 } from "@piui/protocol"

type TimelineCursor = { v: 1; epoch: string; beforeId: string }
const cursorSecret = randomBytes(32)

export function timelinePage(
  timeline: TimelineItemV1[],
  epoch: string,
  options: { cursor?: string; limit: number; maxBytes: number },
): PiTimelinePageV1 {
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined
  if (decoded && decoded.epoch !== epoch) throw staleCursor("timeline cursor belongs to another session epoch")
  let before = timeline.length
  if (decoded) {
    before = timeline.findIndex(item => item.id === decoded.beforeId)
    if (before < 0) throw staleCursor("timeline anchor is no longer on the active branch")
  }
  const items: TimelineItemV1[] = []
  let index = before - 1
  while (index >= 0 && items.length < options.limit) {
    const item = timeline[index]!
    const candidate = [item, ...items]
    const candidateStart = index
    const candidateCursor = candidateStart > 0 ? encodeCursor({ v: 1, epoch, beforeId: item.id }) : undefined
    if (Buffer.byteLength(JSON.stringify({
      items: candidate,
      beforeCursor: candidateCursor,
      hasMore: candidateStart > 0,
    }), "utf8") > options.maxBytes) {
      if (!items.length) throw Object.assign(new Error("timeline item exceeds the page byte limit"), { code: "FILE_TOO_LARGE" })
      break
    }
    items.unshift(item)
    index -= 1
  }
  const start = index + 1
  return {
    items,
    beforeCursor: start > 0 && items[0]
      ? encodeCursor({ v: 1, epoch, beforeId: items[0].id })
      : undefined,
    hasMore: start > 0,
  }
}

function encodeCursor(cursor: TimelineCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
  const signature = createHmac("sha256", cursorSecret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

function decodeCursor(cursor: string): TimelineCursor {
  try {
    const [payload, signature] = cursor.split(".")
    if (!payload || !signature) throw new Error("bad cursor")
    const expected = createHmac("sha256", cursorSecret).update(payload).digest()
    const actual = Buffer.from(signature, "base64url")
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("bad cursor")
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<TimelineCursor>
    if (value.v !== 1 || typeof value.epoch !== "string" || typeof value.beforeId !== "string") throw new Error("bad cursor")
    return value as TimelineCursor
  } catch {
    throw Object.assign(new Error("invalid pagination cursor"), { code: "INVALID_REQUEST" })
  }
}

function staleCursor(message: string): Error {
  return Object.assign(new Error(message), { code: "STALE_CURSOR" })
}
