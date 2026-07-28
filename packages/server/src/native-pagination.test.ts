import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { PiNativeSessionEnvelopeV1 } from "@piui/protocol"
import { nativeEntriesPage, nativeEntriesPageFromEntries, nativeImageAttachment } from "@piui/pi-worker"

function envelope(count = 120): PiNativeSessionEnvelopeV1 {
  return {
    namespace: "pi",
    schemaVersion: 1,
    sdkVersion: "0.81.1",
    revision: 1,
    sessionFormatVersion: 3,
    header: { type: "session", version: 3, id: "page-session", timestamp: "2026-01-01T00:00:00.000Z" },
    leafId: `entry-${count - 1}`,
    entries: Array.from({ length: count }, (_, index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: { role: "user", content: [{ type: "text", text: `message ${index}` }] },
      unknownFutureField: { nested: [index, false, null] },
    })),
    tree: [],
  }
}

describe("native pagination", () => {
  it("reassembles every original Pi entry without modification", () => {
    const native = envelope()
    let cursor: string | undefined
    let collected: PiNativeSessionEnvelopeV1["entries"] = []
    do {
      const page = nativeEntriesPage(native, { cursor, limit: 17, maxBytes: 4_096 })
      collected = [...page.items, ...collected]
      cursor = page.beforeCursor
      if (!page.hasMore) break
    } while (cursor)
    assert.deepEqual(collected, native.entries)
  })

  it("keeps an older cursor valid when entries are appended and rejects another epoch", () => {
    const native = envelope(60)
    const latest = nativeEntriesPage(native, { limit: 10, maxBytes: 1_000_000 })
    assert.ok(latest.beforeCursor)
    const appended = envelope(61)
    const older = nativeEntriesPage(appended, { cursor: latest.beforeCursor, limit: 10, maxBytes: 1_000_000 })
    assert.equal(older.items.at(-1)?.id, "entry-49")
    const other = { ...appended, header: { type: "session", version: 3, id: "other-session" } }
    assert.throws(
      () => nativeEntriesPage(other, { cursor: latest.beforeCursor, limit: 10, maxBytes: 1_000_000 }),
      error => (error as { code?: string }).code === "STALE_CURSOR",
    )
  })

  it("rejects tampered cursors and enforces the complete response byte limit", () => {
    const native = envelope(10)
    const latest = nativeEntriesPage(native, { limit: 2, maxBytes: 1_000_000 })
    assert.ok(latest.beforeCursor)
    assert.throws(
      () => nativeEntriesPage(native, { cursor: `${latest.beforeCursor}x`, limit: 2, maxBytes: 1_000_000 }),
      error => (error as { code?: string }).code === "INVALID_REQUEST",
    )
    assert.throws(
      () => nativeEntriesPage(native, { limit: 2, maxBytes: 16 }),
      error => (error as { code?: string }).code === "FILE_TOO_LARGE",
    )
    const bounded = nativeEntriesPage(native, { limit: 10, maxBytes: 1_500 })
    assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 1_500)
  })

  it("counts the latest branch checkpoint against the byte limit", () => {
    const native = envelope(1)
    const head = nativeEntriesPage(native, { limit: 1, maxBytes: 1_000_000 }).head
    assert.throws(
      () => nativeEntriesPageFromEntries(head, native.entries, {
        limit: 1,
        maxBytes: 512,
        checkpoint: {
          position: { epoch: "worker-events", sequence: 3 },
          liveMessage: {
            id: "live",
            revision: 3,
            phase: "streaming",
            message: { role: "assistant", content: "x".repeat(1_000) },
          },
        },
      }, entry => entry),
      error => (error as { code?: string }).code === "FILE_TOO_LARGE",
    )
  })

  it("returns the exact decoded image block and immutable ETag", () => {
    const native = envelope(1)
    native.entries[0]!.message = {
      role: "user",
      content: [{ type: "text", text: "image" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    }
    const attachment = nativeImageAttachment(native, "entry-0", 1)
    assert.equal(attachment.mimeType, "image/png")
    assert.equal(Buffer.from(attachment.data, "base64").toString(), "image")
    assert.match(attachment.etag, /^"[a-f0-9]{64}"$/)
  })
})
