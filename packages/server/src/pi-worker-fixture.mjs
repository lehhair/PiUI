import path from "node:path"

let session
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
const generation = "fixture-generation"
const heartbeatIntervalMs = 20
const heartbeatTimer = setInterval(() => {
  process.send?.({ kind: "heartbeat", generation, timestamp: Date.now() })
}, heartbeatIntervalMs)

process.send?.({
  kind: "hello",
  workerProtocolVersion: 7,
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
    role: "user",
    preview: "fixture",
  }
  return {
    sessionId,
    sessionFile,
    sessionName: "Fixture",
    projection: { timeline: [], isStreaming: false },
    state: state(),
    entries: [entry],
    tree: [{ entry, children: [] }],
    leafId: entry.id,
  }
}

process.on("message", request => {
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
    result = { type: "models", models: [{ id: "fixture-model", name: "Fixture", providerId: "fixture", family: "fixture", contextLimit: 1, outputLimit: 1, supportsReasoning: false, thinkingLevels: ["off"], supportsImages: false }] }
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
    if (command.text === "stale") {
      process.send?.({
        kind: "event",
        generation: "stale-generation",
        type: "projection",
        projection: {
          timeline: [{ type: "user", id: "stale-entry", entryId: "stale-entry", timestamp: 1, text: "stale" }],
          isStreaming: false,
        },
      })
      result = { type: "session", session: session ?? snapshot() }
      process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
      return
    }
    if (command.text === "reconcile") {
      const synthetic = {
        timeline: [{ type: "user", id: "synthetic-entry", entryId: "synthetic-entry", timestamp: 1, text: command.text }],
        isStreaming: true,
      }
      const projection = {
        timeline: [{ type: "user", id: "native-entry", entryId: "native-entry", timestamp: 1, text: command.text }],
        removedItemIds: ["synthetic-entry"],
        isStreaming: false,
      }
      process.send?.({ kind: "event", generation, type: "projectionDelta", projection: synthetic })
      process.send?.({ kind: "event", generation, type: "projectionDelta", projection })
      session = { ...(session ?? snapshot()), projection: { timeline: projection.timeline, isStreaming: false } }
      result = { type: "session", session }
      process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
      return
    }
    const projection = {
      timeline: [{ type: "user", id: "fixture-entry", entryId: "fixture-entry", timestamp: 1, text: command.text }],
      isStreaming: false,
    }
    process.send?.({
      kind: "event",
      generation,
      type: "nativeEvent",
      event: { type: "turn_start", turnIndex: 0 },
    })
    session = { ...(session ?? snapshot()), projection }
    process.send?.({ kind: "event", generation, type: "projectionDelta", projection })
    result = { type: "session", session }
  } else if (command.type === "setThinkingLevel") {
    thinkingLevel = command.level
    session = { ...(session ?? snapshot()), state: state() }
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
      process.send?.({ kind: "event", generation, type: "state", state: session.state })
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
      process.send?.({ kind: "event", generation, type: "state", state: session.state })
    }
    result = { type: "session", session: session ?? snapshot() }
  } else if (command.type === "steer" || command.type === "followUp") {
    if (command.type === "steer") steering = [...steering, command.text]
    else followUp = [...followUp, command.text]
    session = { ...(session ?? snapshot()), state: state() }
    process.send?.({ kind: "event", generation, type: "state", state: session.state })
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
        header: { type: "session", id: "fixture-session", cwd: runtimeCwd },
        entries: [],
        branch: [],
        contextEntries: [],
        context: { messages: [], thinkingLevel, model: null },
        agentMessages: [],
        lastAssistantText: undefined,
        userMessagesForForking: [],
      },
    }
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
    result = { type: "skills", skills: [{ name: "fixture-skill", source: "fixture" }] }
  } else if (command.type === "listCommands") {
    result = { type: "commands", commands: [{ name: "fixture-command", source: "builtin" }] }
  } else if (command.type === "navigateTree") {
    result = { type: "navigation", cancelled: false, editorText: "fixture draft", session: session ?? snapshot() }
  } else if (command.type === "setLabel") {
    const current = session ?? snapshot()
    current.tree[0].label = command.label
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
  } else {
    result = { type: "session", session: session ?? snapshot() }
  }
  process.send?.({ kind: "response", id: request.id, generation, ok: true, result })
  if (command.type === "dispose") {
    clearInterval(heartbeatTimer)
    setImmediate(() => process.exit(0))
  }
})
