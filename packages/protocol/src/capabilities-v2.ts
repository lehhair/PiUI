import type { ExtensionUiMethodCapabilityV1 } from "./extension-ui.js"

export const PI_CAPABILITY_IDS = [
  "session.list",
  "session.create",
  "session.open",
  "session.delete",
  "session.name",
  "session.archive",
  "session.share",
  "session.tree",
  "session.navigate",
  "session.fork",
  "session.clone",
  "session.new",
  "session.switch",
  "session.import",
  "session.export",
  "prompt.text",
  "prompt.multimodal",
  "prompt.steer",
  "prompt.followUp",
  "queue.manage",
  "retry.manage",
  "compaction.manage",
  "bash.user",
  "tools.manage",
  "extension.commands",
  "extension.ui",
  "resources.reload",
  "settings.manage",
  "packages.manage",
  "project.trust",
  "providers.auth",
  "models.manage",
  "models.llamaCpp",
  "files.read",
  "files.write",
  "files.search",
  "workspace.manage",
  "git.diff",
  "git.status",
  "events.workspace",
  "git.worktree",
  "integrations.mcp",
  "pty",
] as const

export type PiCapabilityId = (typeof PI_CAPABILITY_IDS)[number]
export type CapabilityScopeV2 = "server" | "workspace" | "session" | "model"

export interface CapabilityDescriptorV2 {
  enabled: boolean
  version: number
  scope: CapabilityScopeV2
  reason?: string
  limits?: Record<string, string | number | boolean>
  methods?: Record<string, ExtensionUiMethodCapabilityV1>
}

export interface CapabilityManifestV2 {
  protocolVersion: 2
  revision: string
  capabilities: Partial<Record<PiCapabilityId, CapabilityDescriptorV2>>
}
