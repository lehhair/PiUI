import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  PI_CAPABILITY_IDS,
  PI_PARITY_SDK_VERSION,
  PROTOCOL_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  eventStreamKeyV2,
  isCompactionStateV1,
  isQueueStateV1,
  isRetryStateV1,
  isRuntimeControlStateV1,
  parseEventStreamKeyV2,
  type EventEnvelopeV2,
  type CommandRequestV2,
  type SessionSnapshotV1,
} from "./index.js"

describe("protocol v2 foundation", () => {
  it("pins the Pi parity and supported protocol versions", () => {
    assert.equal(PI_PARITY_SDK_VERSION, "0.81.1")
    assert.equal(PROTOCOL_V2, 2)
    assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, [1, 2])
  })

  it("keeps capability identifiers unique", () => {
    assert.equal(new Set(PI_CAPABILITY_IDS).size, PI_CAPABILITY_IDS.length)
  })

  it("uses scoped cursors and typed event payloads", () => {
    const event: EventEnvelopeV2<"session.runtime.replaced"> = {
      protocolVersion: 2,
      stream: { kind: "session", id: "session-1" },
      cursor: { epoch: "epoch-1", sequence: 3 },
      eventId: "event-3",
      timestamp: "2026-07-25T00:00:00.000Z",
      type: "session.runtime.replaced",
      payload: { sessionId: "session-1", workerGeneration: "worker-1" },
    }
    assert.equal(event.stream.kind, "session")
    assert.equal(event.payload.workerGeneration, "worker-1")
    assert.equal(eventStreamKeyV2(event.stream), "session:session-1")
    assert.deepEqual(parseEventStreamKeyV2("session:session-1"), event.stream)
  })

  it("round-trips a workspace path as a stream identity", () => {
    const stream = { kind: "workspace" as const, id: "C:\\Users\\me\\My Project" }
    const key = eventStreamKeyV2(stream)
    assert.equal(key, "workspace:C%3A%5CUsers%5Cme%5CMy%20Project")
    assert.deepEqual(parseEventStreamKeyV2(key), stream)
  })

  it("declares command concurrency explicitly", () => {
    const command: CommandRequestV2<"session.navigateTree"> = {
      protocolVersion: 2,
      commandId: "command-1",
      type: "session.navigateTree",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { entryId: "entry-1", summarizeAbandonedBranch: true },
    }
    assert.equal(command.concurrency, "idle-only")
    assert.equal(command.payload.entryId, "entry-1")
  })

  it("types native Pi tree entries and replacement commands", () => {
    const native: SessionSnapshotV1["native"] = {
      namespace: "pi",
      schemaVersion: 1,
      leafId: "entry-1",
      entries: [{
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "user",
        preview: "hello",
      }],
      tree: [],
    }
    const fork: CommandRequestV2<"session.fork"> = {
      protocolVersion: 2,
      commandId: "fork-1",
      type: "session.fork",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { entryId: "entry-1", position: "before" },
    }
    assert.equal(native.entries[0]?.type, "message")
    assert.equal(fork.payload.position, "before")
  })

  it("validates concrete R4 runtime state and rejects malformed variants", () => {
    const runtimeState = {
      queue: {
        steering: ["correct this"],
        followUp: ["then test"],
        steeringMode: "all",
        followUpMode: "one-at-a-time",
      },
      retry: {
        phase: "waiting",
        autoEnabled: true,
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        nextAttemptAt: "2026-01-01T00:00:01.000Z",
        errorMessage: "503 overloaded",
      },
      compaction: {
        autoEnabled: true,
        operation: { type: "branchSummary", phase: "running", targetEntryId: "entry-1" },
      },
      tools: [{ name: "read", description: "Read files", source: "builtin" }],
      activeTools: ["read"],
    }
    assert.equal(isRuntimeControlStateV1(runtimeState), true)
    assert.equal(isQueueStateV1({ ...runtimeState.queue, steering: [42] }), false)
    assert.equal(isRetryStateV1({ ...runtimeState.retry, delayMs: -1 }), false)
    assert.equal(isCompactionStateV1({
      autoEnabled: true,
      operation: { type: "branchSummary", phase: "running" },
    }), false)
  })

  it("declares independent R4 control commands", () => {
    const prompt: CommandRequestV2<"session.prompt"> = {
      protocolVersion: 2,
      commandId: "prompt-1",
      type: "session.prompt",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: {
        text: "hello",
        model: { provider: "anthropic", modelId: "claude" },
        thinkingLevel: "high",
      },
    }
    const steer: CommandRequestV2<"session.steer"> = {
      protocolVersion: 2,
      commandId: "steer-1",
      type: "session.steer",
      concurrency: "run-control",
      sessionId: "session-1",
      payload: { text: "change direction" },
    }
    const tools: CommandRequestV2<"session.setActiveTools"> = {
      protocolVersion: 2,
      commandId: "tools-1",
      type: "session.setActiveTools",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { toolNames: ["read", "bash"] },
    }
    assert.equal(prompt.payload.thinkingLevel, "high")
    assert.equal(steer.payload.text, "change direction")
    assert.deepEqual(tools.payload.toolNames, ["read", "bash"])
  })

  it("types native attachments, user bash, export, and reload commands", () => {
    const prompt: CommandRequestV2<"session.prompt"> = {
      protocolVersion: 2,
      commandId: "prompt-image",
      type: "session.prompt",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: {
        text: "inspect",
        attachments: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
      },
    }
    const bash: CommandRequestV2<"session.executeBash"> = {
      protocolVersion: 2,
      commandId: "bash-1",
      type: "session.executeBash",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { command: "git status", excludeFromContext: true },
    }
    const exportJsonl: CommandRequestV2<"session.exportJsonl"> = {
      protocolVersion: 2,
      commandId: "export-1",
      type: "session.exportJsonl",
      concurrency: "idle-only",
      sessionId: "session-1",
      payload: { outputPath: "exports/session.jsonl" },
    }
    assert.equal(prompt.payload.attachments?.[0]?.type, "image")
    assert.equal(bash.payload.excludeFromContext, true)
    assert.equal(exportJsonl.payload.outputPath, "exports/session.jsonl")
  })
})
