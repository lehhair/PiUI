import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { EventCursor, JsonObject, JsonValue } from "@piui/protocol"
import type { BranchCheckpoint, EntriesPage, LiveMessage, SessionHead } from "@piui/protocol"

export type { BranchCheckpoint, EntriesPage, LiveMessage, SessionHead }

type NativeCursor = { v: 1; epoch: string; beforeId: string }

/**
 * 光标 HMAC 密钥。优先用服务端注入的持久化密钥（PIUI_CURSOR_SECRET），
 * 这样 worker 进程重启（空闲回收后重新 attach）后旧光标依然有效；
 * 没有注入时退回每进程随机密钥（独立运行场景）。
 */
const cursorSecret = resolveCursorSecret()

function resolveCursorSecret(): Buffer {
  const configured = process.env.PIUI_CURSOR_SECRET?.trim()
  if (configured) {
    const decoded = Buffer.from(configured, "base64url")
    if (decoded.length >= 32) return decoded.subarray(0, 32)
  }
  return randomBytes(32)
}

export function sessionHeadFromParts(
  parts: Omit<SessionHead, "epoch">,
  epochSeed: unknown = parts.header,
): SessionHead {
  return {
    ...parts,
    epoch: createHash("sha256").update(JSON.stringify(epochSeed)).digest("base64url").slice(0, 22),
  }
}

export function entriesPageFromEntries<T>(
  head: SessionHead,
  entries: readonly T[],
  options: { cursor?: string; limit: number; maxBytes: number; checkpoint?: BranchCheckpoint },
  serialize: (entry: T) => JsonObject,
): EntriesPage {
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined
  if (decoded && decoded.epoch !== head.epoch) throw staleCursor("cursor belongs to another session epoch")
  const before = decoded
    ? entries.findIndex(entry => entryIdOf(entry) === decoded.beforeId)
    : entries.length
  if (before < 0) throw staleCursor("cursor anchor is no longer in the session")
  const emptyPage = { head, items: [], checkpoint: options.checkpoint, hasMore: before > 0 }
  if (Buffer.byteLength(JSON.stringify(emptyPage), "utf8") > options.maxBytes) {
    throw Object.assign(new Error("page metadata exceeds the byte limit"), { code: "FILE_TOO_LARGE" })
  }
  const selected: JsonObject[] = []
  let index = before - 1
  while (index >= 0 && selected.length < options.limit) {
    const item = serialize(entries[index]!)
    if (typeof item.id !== "string") {
      throw Object.assign(new Error("Pi session entry id is not a string"), { code: "NATIVE_DATA_NOT_JSON" })
    }
    const candidate = [item, ...selected]
    const candidateStart = index
    const candidateCursor = candidateStart > 0 && candidate[0]
      ? encodeCursor({ v: 1, epoch: head.epoch, beforeId: String(candidate[0].id) })
      : undefined
    const candidatePage = {
      head,
      items: candidate,
      checkpoint: options.checkpoint,
      beforeCursor: candidateCursor,
      hasMore: candidateStart > 0,
    }
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidatePage), "utf8")
    if (candidateBytes > options.maxBytes) {
      if (!selected.length) throw Object.assign(new Error("entry exceeds the page byte limit"), { code: "FILE_TOO_LARGE" })
      break
    }
    selected.unshift(item)
    index -= 1
  }
  const start = index + 1
  return {
    head,
    items: selected,
    checkpoint: options.checkpoint,
    beforeCursor: start > 0 && selected[0]
      ? encodeCursor({ v: 1, epoch: head.epoch, beforeId: String(selected[0].id) })
      : undefined,
    hasMore: start > 0,
  }
}

export function imageAttachmentFromEntry(
  entry: JsonObject,
  blockIndex: number,
): { mimeType: string; data: string; etag: string } {
  const message = asRecord(entry.message)
  const content = message.content
  if (!Array.isArray(content)) throw notFound("entry has no message content")
  const block = asRecord(content[blockIndex] as JsonValue)
  if (block.type !== "image" || typeof block.mimeType !== "string" || typeof block.data !== "string") {
    throw notFound("image block not found")
  }
  return {
    mimeType: block.mimeType,
    data: block.data,
    etag: `"${createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex")}"`,
  }
}

function encodeCursor(cursor: NativeCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
  const signature = createHmac("sha256", cursorSecret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

function decodeCursor(cursor: string): NativeCursor {
  try {
    const [payload, signature] = cursor.split(".")
    if (!payload || !signature) throw new Error("bad cursor")
    const expected = createHmac("sha256", cursorSecret).update(payload).digest()
    const actual = Buffer.from(signature, "base64url")
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("bad cursor")
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<NativeCursor>
    if (value.v !== 1 || typeof value.epoch !== "string" || typeof value.beforeId !== "string") throw new Error("bad cursor")
    return value as NativeCursor
  } catch {
    throw Object.assign(new Error("invalid pagination cursor"), { code: "INVALID_REQUEST" })
  }
}

function asRecord(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function entryIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

function staleCursor(message: string): Error {
  return Object.assign(new Error(message), { code: "STALE_CURSOR" })
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "NOT_FOUND" })
}
