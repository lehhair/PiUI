import {
  PI_CAPABILITY_IDS,
  PI_PARITY_SDK_VERSION,
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

export function createCapabilityManifestV2(): CapabilityManifestV2 {
  const unavailable = Object.fromEntries(
    PI_CAPABILITY_IDS.map(id => [id, capability(false, "server", "Not implemented in PiUI yet")]),
  ) as Record<PiCapabilityId, CapabilityDescriptorV2>

  return {
    protocolVersion: PROTOCOL_V2,
    revision: "pi-0.81.1-r0",
    capabilities: {
      ...unavailable,
      "session.list": capability(true, "workspace"),
      "session.create": capability(true, "workspace"),
      "session.open": capability(true, "session"),
      "session.delete": capability(false, "session", "Deletion is not durable yet"),
      "session.tree": capability(false, "session", "Native tree is not exposed to the UI yet"),
      "prompt.text": capability(true, "session"),
      "prompt.followUp": capability(false, "session", "Follow-up does not yet bypass the prompt executor"),
      "compaction.manage": capability(true, "session", undefined, {
        customInstructions: false,
        abort: false,
      }),
      "models.manage": capability(true, "server", undefined, {
        authentication: false,
        extensionProviders: false,
        scopedModels: false,
      }),
      "files.read": capability(true, "workspace"),
      "files.write": capability(true, "workspace"),
      "git.diff": capability(true, "workspace", undefined, { scopes: "git,branch" }),
    },
  }
}

export function createProtocolHandshakeV2(): ProtocolHandshakeV2 {
  return {
    service: "piui-server",
    preferredProtocolVersion: PROTOCOL_V2,
    supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    piSdkVersion: PI_PARITY_SDK_VERSION,
    capabilities: createCapabilityManifestV2(),
  }
}
