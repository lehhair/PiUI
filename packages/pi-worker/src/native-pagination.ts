import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type {
  PiNativeEntriesPageV1,
  PiNativeBranchCheckpointV1,
  PiNativeJsonValueV1,
  PiNativeSessionEnvelopeV1,
  PiNativeSessionHeadV1,
} from "@piui/protocol"

type NativeCursor = { v: 1; epoch: string; beforeId: string }
const cursorSecret = randomBytes(32)

export function nativeSessionHead(native: PiNativeSessionEnvelopeV1): PiNativeSessionHeadV1 {
  return nativeSessionHeadFromParts({
    sdkVersion: native.sdkVersion,
    revision: native.revision,
    sessionFormatVersion: native.sessionFormatVersion,
    header: native.header,
    leafId: native.leafId,
    entryCount: native.entries.length,
  })
}

export function nativeSessionHeadFromParts(
  parts: Omit<PiNativeSessionHeadV1, "namespace" | "schemaVersion" | "epoch">,
  epochSeed: unknown = parts.header,
): PiNativeSessionHeadV1 {
  return {
    namespace: "pi",
    schemaVersion: 1,
    ...parts,
    epoch: createHash("sha256").update(JSON.stringify(epochSeed)).digest("base64url").slice(0, 22),
  }
}

export function nativeEntriesPage(
  native: PiNativeSessionEnvelopeV1,
  options: { cursor?: string; limit: number; maxBytes: number },
): PiNativeEntriesPageV1 {
  const head = nativeSessionHead(native)
  return nativeEntriesPageFromEntries(head, native.entries, options, item => item)
}

export function nativeEntriesPageFromEntries<T>(
  head: PiNativeSessionHeadV1,
  entries: readonly T[],
  options: { cursor?: string; limit: number; maxBytes: number; checkpoint?: PiNativeBranchCheckpointV1 },
  serialize: (entry: T) => { [key: string]: PiNativeJsonValueV1 },
): PiNativeEntriesPageV1 {
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined
  if (decoded && decoded.epoch !== head.epoch) throw staleCursor("native cursor belongs to another session epoch")
  const before = decoded
    ? entries.findIndex(entry => entryId(entry) === decoded.beforeId)
    : entries.length
  if (before < 0) throw staleCursor("native cursor anchor is no longer in the session")
  const emptyPage = { head, items: [], checkpoint: options.checkpoint, hasMore: before > 0 }
  if (Buffer.byteLength(JSON.stringify(emptyPage), "utf8") > options.maxBytes) {
    throw Object.assign(new Error("native page metadata exceeds the byte limit"), { code: "FILE_TOO_LARGE" })
  }
  const selected: Array<{ [key: string]: PiNativeJsonValueV1 }> = []
  let index = before - 1
  while (index >= 0 && selected.length < options.limit) {
    const item = serialize(entries[index]!)
    if (typeof item.id !== "string") {
      throw Object.assign(new Error("Pi session entry id is not a string"), { code: "NATIVE_SESSION_NOT_JSON" })
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
      if (!selected.length) throw Object.assign(new Error("native entry exceeds the page byte limit"), { code: "FILE_TOO_LARGE" })
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

export function nativeImageAttachment(
  native: PiNativeSessionEnvelopeV1,
  entryId: string,
  blockIndex: number,
): { mimeType: string; data: string; etag: string } {
  const entry = native.entries.find(item => item.id === entryId)
  if (!entry) throw notFound("native entry not found")
  return nativeImageAttachmentFromEntry(entry, blockIndex)
}

export function nativeImageAttachmentFromEntry(
  entry: { [key: string]: PiNativeJsonValueV1 },
  blockIndex: number,
): { mimeType: string; data: string; etag: string } {
  const message = asRecord(entry.message)
  const content = message.content
  if (!Array.isArray(content)) throw notFound("native entry has no message content")
  const block = asRecord(content[blockIndex])
  if (block.type !== "image" || typeof block.mimeType !== "string" || typeof block.data !== "string") {
    throw notFound("native image block not found")
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

function asRecord(value: PiNativeJsonValueV1 | undefined): { [key: string]: PiNativeJsonValueV1 } {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function entryId(value: unknown): string | undefined {
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
