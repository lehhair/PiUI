import path from "node:path"

let session
let fullNative
let listCount = 0
let replacementCount = 0
let runtimeCwd = "/fixture"
let steering = []
let followUp = []
let steeringMode = "one-at-a-time"
let followUpMode = "one-at-a-time"
let autoCompaction = true
let autoRetry = true
let activeTools = ["read"]
let thinkingLevel = "medium"
let model
let isCompacting = false
let pendingCompaction
let nativeEventSequence = 0
let nativeEventEpoch = "fixture-native-events"
const generation = "fixture-generation"
const pendingHostCalls = new Map()
let hostCallSequence = 0
const heartbeatIntervalMs = 20
const heartbeatTimer = setInterval(() => {
  process.send?.({ kind: "heartbeat", generation, timestamp: Date.now() })
}, heartbeatIntervalMs)

process.send?.({
  kind: "hello",
  workerProtocolVersion: 15,
  piSdkVersion: "0.81.1",
  generation,
  processId: process.pid,
  heartbeatIntervalMs,
  capabilities: [
    "catalog.sessions",
    "catalog.models",
    "runtime.open",
    "runtime.prompt",
    "runtime.control",
    "runtime.abort",
    "runtime.model",
    "runtime.thinking",
    "runtime.compact",
    "runtime.retry",
    "runtime.tools",
    "runtime.tree",
    "runtime.fork",
    "runtime.import",
    "runtime.skills",
    "runtime.commands",
    "runtime.bash",
    "runtime.export",
    "runtime.reload",
    "runtime.extensionUi",
    "management.settings",
    "management.trust",
    "management.auth",
    "management.packages",
  ],
})

function state() {
  return {
    thinkingLevel,
    availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
    isStreaming: false,
    isCompacting,
    isIdle: !isCompacting,
    isBashRunning: false,
    hasPendingBashMessages: false,
    isRetrying: false,
    retryAttempt: 0,
    pendingMessageCount: steering.length + followUp.length,
    queue: {
      steering,
      followUp,
      steeringMode,
      followUpMode,
    },
    retry: { phase: "idle", autoEnabled: autoRetry },
    compaction: {
      autoEnabled: autoCompaction,
      operation: isCompacting ? { type: "compaction", phase: "running", reason: "manual" } : { type: "none" },
    },
    tools: [
      { name: "read", description: "Read files", source: "builtin" },
      { name: "bash", description: "Run commands", source: "builtin" },
    ],
    activeTools,
    model,
    supportsThinking: true,
  }
}

function snapshot(sessionId = "fixture-session", sessionFile = "/fixture/session.jsonl") {
  const entry = {
    type: "message",
    id: "fixture-entry",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "fixture", textSignature: "text-signature" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      metadata: { nested: { preserved: true } },
    },
    futureField: { unknown: [1, "two", false, null] },
  }
  const futureEntry = {
    type: "future_pi_entry",
    id: "future-entry",
    parentId: entry.id,
    timestamp: "2026-01-01T00:00:01.000Z",
    payload: { untouched: { deep: ["value"] } },
  }
  fullNative = {
    namespace: "pi",
    schemaVersion: 1,
    sdkVersion: "0.81.1",
    revision: 1,
    sessionFormatVersion: 3,
    header: { type: "session", version: 3, id: sessionId },
    entries: [entry, futureEntry],
    tree: [{ entry, children: [{ entry: futureEntry, children: [] }] }],
    leafId: entry.id,
  }
  return {
    sessionId,
    sessionFile,
    sessionName: "Fixture",
    state: state(),
    native: {
      namespace: "pi",
      schemaVersion: 1,
      sdkVersion: "0.81.1",
      revision: 1,
      sessionFormatVersion: 3,
      header: { type: "session", version: 3, id: sessionId },
      epoch: Buffer.from(sessionId).toString("base64url"),
      leafId: entry.id,
      entryCount: 2,
    },
  }
}

function callHost(call) {
  const id = `fixture-host-${++hostCallSequence}`
  return new Promise((resolve, reject) => {
    pendingHostCalls.set(id, { resolve, reject })
    process.send?.({ kind: "hostCall", id, generation, call })
  })
}

process.on("message", async request => {
  if (request?.kind === "hostReply") {
    const pending = pendingHostCalls.get(request.id)
    if (!pending) return
    pendingHostCalls.delete(request.id)
    if (request.ok) pending.resolve()
    else pending.reject(Object.assign(new Error(request.error.message), { code: request.error.code }))
    return
  }
  if (request.generation !== generation) {
    process.send?.({
      kind: "response",
      id: request.id,
      generation,
      ok: false,
      error: { code: "WORKER_GENERATION_MISMATCH", message: "generation mismatch" },
    })
    return
  }
  if (request.sessionId && request.sessionId !== session?.sessionId) {
    process.send?.({
      kind: "response",
      id: request.id,
      generation,
      ok: false,
      error: { code: "RUNTIME_REPLACED", message: "runtime session mismatch" },
    })
    return
  }
  const command = request.command
  let result
  if (command.type === "list" || command.type === "listAll") {
    listCount += 1
    result = {
      type: "sessions",
      sessions: [{
        id: "fixture-session",
        path: "/fixture/session.jsonl",
        cwd: "/fixture",
        name: `Fixture ${listCount}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      }],
    }
  } else if (command.type === "listModels" || command.type === "listRuntimeModels") {
    result = { type: "models", models: [{ id: "fixture-model", name: "Fixture", api: "fixture", provider: "fixture", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }] }
  } else if (command.type === "getSettings" || command.type === "patchSettings") {
    result = {
      type: "settings",
      settings: {
        workspacePath: command.cwd,
        projectTrusted: true,
        global: {},
        project: {},
        effective: command.type === "patchSettings" ? command.patch : {},
        errors: [],
      },
    }
  } else if (command.type === "getProjectTrust" || command.type === "setProjectTrust") {
    const decision = command.type === "setProjectTrust" ? command.decision : null
    result = {
      type: "trust",
      trust: {
        workspacePath: command.cwd,
        required: false,
        decision,
        defaultDecision: "ask",
        trusted: decision ?? true,
      },
    }
  } else if (command.type === "listProviders") {
    result = { type: "providers", providers: [] }
  } else if (command.type === "startProviderAuth") {
    result = { type: "authFlow", flowId: "fixture-auth-flow" }
  } else if (command.type === "inspectModelRuntime") {
    result = {
      type: "modelRuntime",
      runtime: {
        providers: [], models: [], availableModels: [], availableSnapshot: [], credentials: [],
        registeredProviderIds: [], registeredProviderConfigs: {}, authChecks: {},
      },
    }
  } else if (command.type === "refreshModelRuntime") {
    result = { type: "modelRefresh", result: { refreshed: true } }
  } else if (["setRuntimeApiKey", "removeRuntimeApiKey", "reloadModelRuntime"].includes(command.type)) {
    result = { type: "ok" }
  } else if (command.type === "listPackages" || command.type === "managePackage") {
    result = { type: "packages", packages: [] }
  } else if (command.type === "resolvePackages" || command.type === "resolveExtensionSources") {
    result = { type: "packageResources", resources: { extensions: [], skills: [], prompts: [], themes: [] } }
  } else if (command.type === "changePackageSource") {
    result = { type: "packageSource", changed: true, packages: [] }
  } else if (command.type === "getInstalledPackagePath") {
    result = { type: "packagePath", path: "/fixture/package" }
  } else if (command.type === "checkPackageUpdates") {
    result = { type: "packageUpdates", updates: [] }
  } else if (command.type === "open") {
    if (command.cwd.includes("hang-open")) return
    runtimeCwd = command.cwd
    session = snapshot("fixture-session", command.sessionFile ?? path.join(command.cwd, "session.jsonl"))
    result = { type: "session", session }
  } else if (command.type === "prompt") {
    if (command.text === "crash") {
      process.exit(17)
      return
    }
    if (command.text === "hang") {
      clearInterval(heartbeatTimer)
      return
    }
    if (command.text === "wait") {
      setTimeout(() => {
        process.send?.({ kind: "response", id: request.id, generation, ok: true, result: { type: "session", session: session ?? snapshot() } })
      }, 120)
      return
    }
    if (command.text === "extension-new-session") {
      const source = session ?? snapshot()
      const reservationId = `fixture-reservation-${replacementCount + 1}`
      await callHost({
        type: "extensionReplacement.reserve",
        reservationId,
        sourceSessionId: source.sessionId,
        operation: "new",
      })
      replacementCount += 1
      session = snapshot(
        `fixture-extension-${replacementCount}`,
        path.join(runtimeCwd, `extension-${replacementCount}.jsonl`),
      )
      nativeEventEpoch = `fixture-native-events-${replacementCount}`
      nativeEventSequence = 0
      const replacement = {
        operation: "new",
        sourceSessionId: source.sessionId,
        targetSessionId: session.sessionId,
        targetSessionFile: session.sessionFile,
        targetCwd: runtimeCwd,
        cancelled: false,
      }
      process.send?.({
        kind: "event",
        generation,
        sessionId: session.sessionId,
        type: "nativeEvent",
        event: { type: "message_start", message: { role: "user", content: "target before commit" } },
        meta: {
          position: { epoch: nativeEventEpoch, sequence: ++nativeEventSequence },
          liveMessage: { id: "target-before-commit", revision: 1 },
        },
      })
      await callHost({
        type: "extensionReplacement.commit",
        reservationId,
        replacement,
        session,
      })
      result = { type: "session", session }
    } else
    if (command.text === "stale") {
      process.send?.({
        kind: "event",
        generation: "stale-generation",
        sessionId: session?.sessionId ?? "fixture-session",
        type: "nativeEvent",
        event: { type: "message_end", message: { role: "user", content: "stale" } },
        meta: { position: { epoch: nativeEventEpoch, sequence: ++nativeEventSequence }, liveMessage: { id: "stale", revision: 1 } },
      })
      result = { type: "session", session: session ?? snapshot() }
      process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
      return
    }
    if (command.text === "reconcile") {
      process.send?.({
        kind: "event",
        generation,
        sessionId: session?.sessionId ?? "fixture-session",
        type: "nativeEvent",
        event: { type: "message_end", message: { role: "user", content: command.text } },
        meta: { position: { epoch: nativeEventEpoch, sequence: ++nativeEventSequence }, liveMessage: { id: "reconcile", revision: 1 } },
      })
      session = session ?? snapshot()
      result = { type: "session", session }
      process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
      return
    }
    const images = command.images ?? []
    process.send?.({
      kind: "event",
      generation,
      sessionId: session?.sessionId ?? "fixture-session",
      type: "nativeEvent",
      event: { type: "message_start", message: { role: "user", content: [{ type: "text", text: command.text }, ...images] } },
      meta: { position: { epoch: nativeEventEpoch, sequence: ++nativeEventSequence }, liveMessage: { id: "prompt-user", revision: 1 } },
    })
    session = session ?? snapshot()
    fullNative.entries[0].message.content = [
      { type: "text", text: command.text },
      ...images,
    ]
    process.send?.({
      kind: "event",
      generation,
      sessionId: session.sessionId,
      type: "nativeEvent",
      event: { type: "message_end", message: fullNative.entries[0].message },
      meta: { position: { epoch: nativeEventEpoch, sequence: ++nativeEventSequence }, liveMessage: { id: "prompt-user", revision: 2 } },
    })
    session.native.revision += 1
    process.send?.({ kind: "event", generation, sessionId: session.sessionId, type: "nativeHead", native: session.native })
    result = { type: "session", session }
  } else if (command.type === "setThinkingLevel") {
    thinkingLevel = command.level
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "cycleThinkingLevel") {
    const levels = ["off", "minimal", "low", "medium", "high"]
    thinkingLevel = levels[(levels.indexOf(thinkingLevel) + 1) % levels.length]
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "thinkingLevel", level: thinkingLevel, session }
  } else if (command.type === "sendUserMessage") {
    session = session ?? snapshot()
    const entry = {
      type: "message",
      id: `fixture-user-${fullNative.entries.length}`,
      parentId: fullNative.leafId,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: command.text },
    }
    fullNative.entries.push(entry)
    fullNative.leafId = entry.id
    session.native = { ...session.native, revision: session.native.revision + 1, leafId: entry.id, entryCount: fullNative.entries.length }
    process.send?.({
      kind: "event",
      generation,
      sessionId: session.sessionId,
      type: "nativeEvent",
      event: { type: "message_end", message: { role: "user", content: command.text } },
      meta: { position: { epoch: nativeEventEpoch, sequence: ++nativeEventSequence }, liveMessage: { id: entry.id, revision: 1 } },
    })
    process.send?.({ kind: "event", generation, sessionId: session.sessionId, type: "nativeHead", native: session.native })
    result = { type: "session", session }
  } else if (command.type === "setModel") {
    model = { provider: command.provider, id: command.modelId, displayName: command.modelId }
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "compact") {
    if (command.instructions === "wait-for-abort") {
      isCompacting = true
      session = { ...(session ?? snapshot()), state: state() }
      pendingCompaction = request
      process.send?.({ kind: "event", generation, sessionId: session.sessionId, type: "state", state: session.state })
      return
    }
    result = {
      type: "compaction",
      compaction: { status: "skipped", reason: "session_too_small", message: "fixture is small" },
      session: session ?? snapshot(),
    }
  } else if (command.type === "abortCompaction") {
    if (pendingCompaction) {
      isCompacting = false
      session = { ...(session ?? snapshot()), state: state() }
      process.send?.({
        kind: "response",
        id: pendingCompaction.id,
        generation,
        ok: true,
        result: { type: "compaction", compaction: { status: "aborted" }, session },
      })
      pendingCompaction = undefined
      process.send?.({ kind: "event", generation, sessionId: session.sessionId, type: "state", state: session.state })
    }
    result = { type: "session", session: session ?? snapshot() }
  } else if (command.type === "steer" || command.type === "followUp") {
    if (command.type === "steer") steering = [...steering, command.text]
    else followUp = [...followUp, command.text]
    session = { ...(session ?? snapshot()), state: state() }
    process.send?.({ kind: "event", generation, sessionId: session.sessionId, type: "state", state: session.state })
    result = { type: "session", session }
  } else if (command.type === "setQueueModes") {
    steeringMode = command.steeringMode ?? steeringMode
    followUpMode = command.followUpMode ?? followUpMode
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "setAutoCompaction") {
    autoCompaction = command.enabled
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "setAutoRetry") {
    autoRetry = command.enabled
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "setActiveTools") {
    activeTools = command.toolNames
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "setScopedModels") {
    result = { type: "scopedModels", diagnostics: [], session: session ?? snapshot() }
  } else if (command.type === "inspectToolDefinition") {
    result = { type: "data", data: { name: command.toolName, description: "Fixture tool" } }
  } else if (command.type === "hasExtensionHandlers") {
    result = { type: "boolean", value: command.eventType === "session_start" }
  } else if (command.type === "appendCustomEntry" || command.type === "waitForIdle") {
    result = { type: "session", session: session ?? snapshot() }
  } else if (command.type === "inspectSystemPrompt") {
    result = { type: "text", text: "Fixture system prompt" }
  } else if (command.type === "inspectRuntime") {
    result = {
      type: "runtimeInspection",
      inspection: {
        native: { ...fullNative, revision: (session ?? snapshot()).native.revision },
        branch: [],
        contextEntries: [],
        context: { messages: [], thinkingLevel, model: null },
        agentMessages: [],
        lastAssistantText: undefined,
        userMessagesForForking: [],
      },
    }
  } else if (command.type === "getNativeEntriesPage") {
    const current = session ?? snapshot()
    const before = command.cursor ? Number(Buffer.from(command.cursor, "base64url").toString("utf8")) : fullNative.entries.length
    const start = Math.max(0, before - command.limit)
    result = {
      type: "nativeEntriesPage",
      page: {
        head: { ...current.native, entryCount: fullNative.entries.length },
        items: fullNative.entries.slice(start, before),
        beforeCursor: start > 0 ? Buffer.from(String(start)).toString("base64url") : undefined,
        hasMore: start > 0,
      },
    }
  } else if (command.type === "getNativeBranchPage") {
    const current = session ?? snapshot()
    const byId = new Map(fullNative.entries.map(entry => [entry.id, entry]))
    const branch = []
    let id = fullNative.leafId
    while (id) {
      const entry = byId.get(id)
      if (!entry) break
      branch.push(entry)
      id = entry.parentId
    }
    branch.reverse()
    const before = command.cursor ? Number(Buffer.from(command.cursor, "base64url").toString("utf8")) : branch.length
    const start = Math.max(0, before - command.limit)
    result = {
      type: "nativeBranchPage",
      page: {
        head: { ...current.native, entryCount: fullNative.entries.length },
        items: branch.slice(start, before),
        checkpoint: command.cursor ? undefined : {
          position: { epoch: nativeEventEpoch, sequence: nativeEventSequence },
        },
        beforeCursor: start > 0 ? Buffer.from(String(start)).toString("base64url") : undefined,
        hasMore: start > 0,
      },
    }
  } else if (command.type === "getNativeTree") {
    result = { type: "nativeTree", tree: fullNative.tree }
  } else if (command.type === "getNativeImageAttachment") {
    const entry = fullNative.entries.find(item => item.id === command.entryId)
    const block = entry?.message?.content?.[command.blockIndex]
    if (!block || block.type !== "image") throw Object.assign(new Error("image not found"), { code: "NOT_FOUND" })
    result = { type: "nativeImageAttachment", mimeType: block.mimeType, data: block.data, etag: '\"fixture-image\"' }
  } else if (command.type === "inspectResources" || command.type === "extendResources") {
    result = {
      type: "resources",
      resources: {
        extensions: [], extensionErrors: [], skills: [], prompts: [], themes: [], agentsFiles: [],
        systemPrompt: "Fixture system prompt", appendSystemPrompt: [], diagnostics: [], runtimeDiagnostics: [],
      },
    }
  } else if (command.type === "executeBash") {
    result = {
      type: "bash",
      result: {
        output: `fixture bash: ${command.command}`,
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
      session: session ?? snapshot(),
    }
  } else if (command.type === "exportHtml" || command.type === "exportJsonl") {
    result = {
      type: "export",
      format: command.type === "exportHtml" ? "html" : "jsonl",
      path: command.outputPath,
    }
  } else if (command.type === "clearQueue") {
    const cleared = { steering, followUp }
    steering = []
    followUp = []
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "queue", ...cleared, session }
  } else if (command.type === "abort") {
    const cleared = { steering, followUp }
    steering = []
    followUp = []
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "queue", ...cleared, session }
  } else if (command.type === "listSkills") {
    result = { type: "skills", skills: [{ name: "fixture-skill", description: "Fixture skill", filePath: "/fixture/SKILL.md", baseDir: "/fixture", sourceInfo: { origin: "top-level" }, disableModelInvocation: false }] }
  } else if (command.type === "listCommands") {
    result = { type: "commands", commands: [{ name: "fixture-command", source: "extension", sourceInfo: { origin: "extension" } }] }
  } else if (command.type === "navigateTree") {
    result = { type: "navigation", cancelled: false, editorText: "fixture draft", session: session ?? snapshot() }
  } else if (command.type === "setLabel") {
    const current = session ?? snapshot()
    fullNative.tree[0].label = command.label
    fullNative.entries.push({
      type: "label",
      id: `label-${fullNative.entries.length}`,
      parentId: current.native.leafId,
      timestamp: new Date().toISOString(),
      targetId: command.entryId,
      label: command.label,
    })
    current.native.revision += 1
    current.native.entryCount = fullNative.entries.length
    session = current
    result = { type: "session", session }
  } else if (command.type === "setSessionName") {
    session = { ...(session ?? snapshot()), sessionName: command.name }
    result = { type: "session", session }
  } else if (["fork", "clone", "newSession", "switchSession", "importSession"].includes(command.type)) {
    const sourceSessionId = (session ?? snapshot()).sessionId
    replacementCount += 1
    const targetSessionId = `fixture-replacement-${replacementCount}`
    const targetSessionFile = path.join(runtimeCwd, `${targetSessionId}.jsonl`)
    session = snapshot(targetSessionId, targetSessionFile)
    result = {
      type: "replacement",
      replacement: {
        sourceSessionId,
        targetSessionId,
        targetSessionFile,
        targetCwd: runtimeCwd,
        selectedText: command.position === "before" ? "fixture draft" : undefined,
        cancelled: false,
      },
      session,
    }
  } else if (command.type === "dispose") {
    result = { type: "ok" }
  } else if (
    command.type === "respondExtensionUi" ||
    command.type === "setExtensionEditorState" ||
    command.type === "respondProviderAuth" ||
    command.type === "cancelProviderAuth" ||
    command.type === "logoutProvider"
  ) {
    // The real worker acknowledges these without returning session state.
    result = { type: "ok" }
  } else if (command.type === "cycleModel") {
    const ids = ["fixture-model", "fixture-model-2"]
    const next = ids[(ids.indexOf(model?.id ?? ids[0]) + 1) % ids.length]
    model = { provider: "fixture", id: next, displayName: next }
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (command.type === "sendCustomMessage") {
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else if (
    command.type === "abortBash" ||
    command.type === "abortBranchSummary" ||
    command.type === "abortRetry" ||
    command.type === "initializeExtensions" ||
    command.type === "reload"
  ) {
    session = { ...(session ?? snapshot()), state: state() }
    result = { type: "session", session }
  } else {
    // Fail loudly: a silent fallback would let a new command pass its tests
    // here while behaving differently against the real worker.
    process.send?.({
      kind: "response",
      id: request.id,
      generation,
      ok: false,
      error: { code: "WORKER_PROTOCOL_MISMATCH", message: `fixture has no branch for ${command.type}` },
    })
    return
  }
  process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
  if (command.type === "dispose") {
    clearInterval(heartbeatTimer)
    setImmediate(() => process.exit(0))
  }
})
