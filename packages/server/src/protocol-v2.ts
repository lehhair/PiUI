import {
  PI_CAPABILITY_IDS,
  PI_PARITY_SDK_VERSION,
  EVENT_WS_SUBPROTOCOL_V2,
  PROTOCOL_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CapabilityDescriptorV2,
  type CapabilityManifestV2,
  type PiCapabilityId,
  type ProtocolHandshakeV2,
} from "@piui/protocol"

function capability(
  enabled: boolean,
  scope: CapabilityDescriptorV2["scope"],
  reason?: string,
  limits?: CapabilityDescriptorV2["limits"],
  methods?: CapabilityDescriptorV2["methods"],
): CapabilityDescriptorV2 {
  return { enabled, version: 1, scope, reason, limits, methods }
}

export function createCapabilityManifestV2(driver: "mock" | "pi" = "pi"): CapabilityManifestV2 {
  const nativePi = driver === "pi"
  const unavailable = Object.fromEntries(
    PI_CAPABILITY_IDS.map(id => [id, capability(false, "server", "Not implemented in PiUI yet")]),
  ) as Record<PiCapabilityId, CapabilityDescriptorV2>

  return {
    protocolVersion: PROTOCOL_V2,
    revision: "pi-0.81.1-r17",
    capabilities: {
      ...unavailable,
      "session.list": capability(true, "workspace"),
      "session.create": capability(true, "workspace"),
      "session.open": capability(true, "session"),
      "session.delete": capability(true, "session"),
      "session.name": capability(true, "session"),
      "session.tree": capability(true, "session", undefined, {
        rawEntries: nativePi,
        runtimeInspection: nativePi,
        pagedEntries: nativePi,
        pagedBranch: nativePi,
        attachmentBinary: nativePi,
        defaultPageSize: 50,
        maxPageSize: 100,
        maxPageBytes: 33_554_432,
      }),
      // Navigation and every replacement path need a bound Pi runtime, so they
      // must not advertise themselves under the mock driver.
      "session.navigate": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        branchSummary: nativePi,
      }),
      "session.fork": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.clone": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.new": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.switch": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.import": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.export": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        html: true,
        jsonl: true,
      }),
      "prompt.text": capability(true, "session", undefined, {
        sendUserMessage: nativePi,
      }),
      "prompt.multimodal": capability(nativePi, "model", nativePi ? undefined : "Requires the Pi runtime", {
        maxImages: 4,
        maxImageBytes: 4.5 * 1024 * 1024,
        maxTotalImageBytes: 16 * 1024 * 1024,
      }),
      "prompt.steer": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "prompt.followUp": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "queue.manage": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        modes: true,
        clear: true,
        removeSingle: false,
      }),
      "retry.manage": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        auto: true,
        abort: true,
      }),
      "compaction.manage": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        customInstructions: true,
        abort: true,
        auto: true,
        branchSummary: true,
      }),
      "bash.user": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        excludeFromContext: true,
        abort: true,
      }),
      "tools.manage": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "extension.commands": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        interactiveUi: true,
        customEntries: true,
        waitForIdle: true,
        handlerInspection: true,
        sessionReplacementContext: true,
        shutdownContext: true,
        browserShortcutInvocation: false,
        tuiRendererTransport: false,
      }),
      "extension.ui": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        maxPendingDialogs: 32,
        maxTextCharacters: 262144,
        maxTitleCharacters: 4096,
        maxDialogOptions: 200,
        maxWidgetLines: 500,
      }, {
        select: { support: "rpc" },
        confirm: { support: "rpc" },
        input: { support: "rpc" },
        editor: { support: "rpc" },
        notify: { support: "rpc" },
        setStatus: { support: "rpc" },
        setWorkingMessage: { support: "web-equivalent" },
        setWorkingVisible: { support: "web-equivalent" },
        setWorkingIndicator: { support: "web-equivalent" },
        setHiddenThinkingLabel: { support: "web-equivalent" },
        "setWidget:string[]": { support: "rpc" },
        setTitle: { support: "rpc" },
        setEditorText: { support: "rpc" },
        pasteToEditor: { support: "rpc" },
        getEditorText: { support: "rpc", reason: "Returns the last editor text acknowledged by the host" },
        "setTheme:string": { support: "web-equivalent" },
        getToolsExpanded: { support: "web-equivalent" },
        setToolsExpanded: { support: "web-equivalent" },
        onTerminalInput: { support: "tui-only", reason: "Terminal byte input has no browser equivalent" },
        "setWidget:component": { support: "tui-only", reason: "TUI component factories are not serializable" },
        setHeader: { support: "tui-only" },
        setFooter: { support: "tui-only" },
        custom: { support: "tui-only" },
        addAutocompleteProvider: { support: "tui-only" },
        setEditorComponent: { support: "tui-only" },
        getEditorComponent: { support: "tui-only" },
        theme: { support: "tui-only" },
        getAllThemes: { support: "rpc" },
        getTheme: { support: "tui-only" },
      }),
      "resources.reload": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        inspect: true,
        extend: true,
        updateEvents: true,
      }),
      "settings.manage": capability(nativePi, "workspace", nativePi ? undefined : "Requires the Pi runtime"),
      "project.trust": capability(nativePi, "workspace", nativePi ? undefined : "Requires the Pi runtime"),
      "providers.auth": capability(nativePi, "server", nativePi ? undefined : "Requires the Pi runtime", {
        apiKey: true,
        oauth: true,
        interactiveFlows: true,
      }),
      "packages.manage": capability(nativePi, "workspace", nativePi ? undefined : "Requires the Pi runtime", {
        userScope: true,
        projectScope: true,
        progressEvents: true,
      }),
      "models.manage": capability(true, "server", undefined, {
        authentication: nativePi,
        extensionProviders: nativePi,
        scopedModels: nativePi,
        cycle: nativePi,
        cycleThinkingLevel: nativePi,
        inspectRuntime: nativePi,
        runtimeApiKeys: nativePi,
        reload: nativePi,
        refresh: nativePi,
        sessionScopedRuntime: nativePi,
      }),
      "workspace.manage": capability(true, "server", undefined, {
        canonicalPathIdentity: true,
        explicitRegistration: true,
      }),
      "files.read": capability(true, "workspace", undefined, {
        maxTextBytes: 2 * 1024 * 1024,
        maxBinaryBytes: 8 * 1024 * 1024,
        maxDirectoryPageSize: 2000,
      }, {
        list: { support: "rpc" },
        read: { support: "rpc" },
        readBinary: { support: "rpc" },
      }),
      "files.write": capability(true, "workspace", undefined, {
        optimisticConcurrency: true,
        atomicReplace: true,
      }, {
        write: { support: "rpc" },
        create: { support: "rpc" },
        move: { support: "rpc" },
        delete: { support: "rpc" },
      }),
      "files.search": capability(true, "workspace", undefined, {
        maxResults: 200,
        maxVisitedEntries: 50_000,
        maxScannedBytes: 32 * 1024 * 1024,
        cancellable: true,
      }, {
        names: { support: "rpc" },
        text: { support: "rpc" },
      }),
      "git.status": capability(true, "workspace", undefined, {
        renameAware: true,
        indexAndWorktree: true,
      }),
      "git.diff": capability(true, "workspace", undefined, {
        scopes: "git,branch,staged,unstaged",
        lazyFilePatch: true,
        maxPatchBytes: 4 * 1024 * 1024,
      }),
      "events.workspace": capability(true, "workspace", undefined, {
        batched: true,
        maxChangesPerEvent: 512,
        maxWatchedWorkspaces: 32,
        fileAndGitInvalidation: true,
      }),
    },
  }
}

export function createProtocolHandshakeV2(driver: "mock" | "pi" = "pi"): ProtocolHandshakeV2 {
  return {
    service: "piui-server",
    preferredProtocolVersion: PROTOCOL_V2,
    supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    piSdkVersion: PI_PARITY_SDK_VERSION,
    capabilities: createCapabilityManifestV2(driver),
    eventTransport: {
      webSocketPath: "/api/v1/events",
      subprotocol: EVENT_WS_SUBPROTOCOL_V2,
      cursorMode: "scoped-map",
    },
  }
}
