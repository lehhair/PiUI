import type { CapabilityManifestV2 } from "./capabilities-v2.js"

export const PI_PARITY_SDK_VERSION = "0.81.1" as const
export const PROTOCOL_V2 = 2 as const
export const SUPPORTED_PROTOCOL_VERSIONS = [1, PROTOCOL_V2] as const

export interface ProtocolHandshakeV2 {
  service: "piui-server"
  preferredProtocolVersion: 2
  supportedProtocolVersions: readonly [1, 2]
  piSdkVersion: typeof PI_PARITY_SDK_VERSION
  capabilities: CapabilityManifestV2
}
