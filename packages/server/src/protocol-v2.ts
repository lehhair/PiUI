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
): CapabilityDescriptorV2 {
  return { enabled, version: 1, scope, reason, limits }
}

export function createCapabilityManifestV2(driver: "mock" | "pi" = "pi"): CapabilityManifestV2 {
  const nativePi = driver === "pi"
  const unavailable = Object.fromEntries(
    PI_CAPABILITY_IDS.map(id => [id, capability(false, "server", "Not implemented in PiUI yet")]),
  ) as Record<PiCapabilityId, CapabilityDescriptorV2>

  return {
    protocolVersion: PROTOCOL_V2,
    revision: "pi-0.81.1-r6",
    capabilities: {
      ...unavailable,
      "session.list": capability(true, "workspace"),
      "session.create": capability(true, "workspace"),
      "session.open": capability(true, "session"),
      "session.delete": capability(true, "session"),
      "session.name": capability(true, "session"),
      "session.tree": capability(true, "session", undefined, { rawEntries: nativePi, runtimeInspection: nativePi }),
      "session.navigate": capability(true, "session", undefined, { branchSummary: nativePi }),
      "session.fork": capability(true, "session"),
      "session.clone": capability(true, "session"),
      "session.new": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.switch": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime"),
      "session.import": capability(true, "session"),
      "session.export": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        html: true,
        jsonl: true,
      }),
      "prompt.text": capability(true, "session"),
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
        sessionReplacementContext: false,
        shutdownContext: false,
      }),
      "extension.ui": capability(nativePi, "session", nativePi ? undefined : "Requires the Pi runtime", {
        supportedMethods: [
          "select", "confirm", "input", "editor", "notify", "setStatus", "setWorkingMessage",
          "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget:string[]",
          "setTitle", "setEditorText", "pasteToEditor", "getEditorText",
        ].join(","),
        unsupportedMethods: [
          "custom", "setHeader", "setFooter", "setEditorComponent", "addAutocompleteProvider", "onTerminalInput",
        ].join(","),
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
        inspectRuntime: nativePi,
        runtimeApiKeys: nativePi,
        reload: nativePi,
        refresh: nativePi,
        sessionScopedRuntime: nativePi,
      }),
      "files.read": capability(true, "workspace"),
      "files.write": capability(true, "workspace"),
      "git.diff": capability(true, "workspace", undefined, { scopes: "git,branch" }),
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
