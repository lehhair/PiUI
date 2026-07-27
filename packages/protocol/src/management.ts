export interface PiSettingsEffectiveV1 {
  lastChangelogVersion?: string
  sessionDir?: string
  defaultProvider?: string
  defaultModel?: string
  defaultThinkingLevel?: PiThinkingLevelV1
  transport: PiTransportV1
  steeringMode: "all" | "one-at-a-time"
  followUpMode: "all" | "one-at-a-time"
  theme?: string
  compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  branchSummary: { reserveTokens: number; skipPrompt: boolean }
  retry: { enabled: boolean; maxRetries: number; baseDelayMs: number }
  providerRetry: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number }
  httpIdleTimeoutMs: number
  websocketConnectTimeoutMs?: number
  externalEditor?: string
  hideThinkingBlock: boolean
  showCacheMissNotices: boolean
  shellPath?: string
  shellCommandPrefix?: string
  quietStartup: boolean
  defaultProjectTrust: "always" | "never" | "ask"
  npmCommand?: string[]
  enableAnalytics: boolean
  trackingId?: string
  enableInstallTelemetry: boolean
  collapseChangelog: boolean
  enableSkillCommands: boolean
  packages: PiPackageSourceV1[]
  extensionPaths: string[]
  skillPaths: string[]
  promptTemplatePaths: string[]
  themePaths: string[]
  showImages: boolean
  imageWidthCells: number
  imageAutoResize: boolean
  blockImages: boolean
  enabledModels?: string[]
  thinkingBudgets?: { minimal?: number; low?: number; medium?: number; high?: number }
  doubleEscapeAction: "fork" | "tree" | "none"
  treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"
  clearOnShrink: boolean
  showTerminalProgress: boolean
  showHardwareCursor: boolean
  editorPaddingX: number
  outputPad: 0 | 1
  autocompleteMaxVisible: number
  codeBlockIndent: string
  warnings: { anthropicExtraUsage?: boolean }
}

export interface PiSettingsSnapshotV1 {
  workspacePath: string
  projectTrusted: boolean
  /** Key names present in each scope. Values stay inside the worker because
   *  Pi preserves unknown user-authored keys that may hold credentials. */
  globalKeys: string[]
  projectKeys: string[]
  effective: PiSettingsEffectiveV1
  errors: Array<{ scope: "global" | "project"; message: string }>
}

export interface ProjectTrustV1 {
  workspacePath: string
  required: boolean
  decision: boolean | null
  inheritedFrom?: string
  defaultDecision: "always" | "never" | "ask"
  trusted: boolean
}

export type PiThinkingLevelV1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
export type PiTransportV1 = "auto" | "sse" | "websocket" | "websocket-cached"

export type PiPackageSourceV1 = string | {
  source: string
  autoload?: boolean
  extensions?: string[]
  skills?: string[]
  prompts?: string[]
  themes?: string[]
}

/** Every serializable setting for which Pi 0.81.1 exposes a persistent setter. */
export interface PiSettingsPatchV1 {
  lastChangelogVersion?: string
  defaultProvider?: string
  defaultModel?: string
  defaultModelAndProvider?: { provider: string; model: string }
  steeringMode?: "all" | "one-at-a-time"
  followUpMode?: "all" | "one-at-a-time"
  theme?: string
  defaultThinkingLevel?: PiThinkingLevelV1
  transport?: PiTransportV1
  compactionEnabled?: boolean
  retryEnabled?: boolean
  httpIdleTimeoutMs?: number
  hideThinkingBlock?: boolean
  showCacheMissNotices?: boolean
  quietStartup?: boolean
  shellPath?: string | null
  shellCommandPrefix?: string | null
  defaultProjectTrust?: "always" | "never" | "ask"
  npmCommand?: string[] | null
  collapseChangelog?: boolean
  enableInstallTelemetry?: boolean
  enableAnalytics?: boolean
  packages?: PiPackageSourceV1[]
  projectPackages?: PiPackageSourceV1[]
  extensionPaths?: string[]
  projectExtensionPaths?: string[]
  skillPaths?: string[]
  projectSkillPaths?: string[]
  promptTemplatePaths?: string[]
  projectPromptTemplatePaths?: string[]
  themePaths?: string[]
  projectThemePaths?: string[]
  enableSkillCommands?: boolean
  showImages?: boolean
  imageWidthCells?: number
  imageAutoResize?: boolean
  blockImages?: boolean
  enabledModels?: string[] | null
  doubleEscapeAction?: "fork" | "tree" | "none"
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"
  clearOnShrink?: boolean
  showTerminalProgress?: boolean
  showHardwareCursor?: boolean
  editorPaddingX?: number
  outputPad?: 0 | 1
  autocompleteMaxVisible?: number
  warnings?: { anthropicExtraUsage?: boolean }
}

export type PackageResolveMissingActionV1 = "install" | "skip" | "error"

export interface ProviderAuthInfoV1 {
  id: string
  name: string
  methods: Array<{ type: "api_key" | "oauth"; name: string; loginAvailable: boolean }>
  configured: boolean
  status: unknown
}

export interface PiModelRuntimeSnapshotV1 {
  providers: ProviderAuthInfoV1[]
  models: unknown[]
  availableModels: unknown[]
  availableSnapshot: unknown[]
  credentials: unknown[]
  registeredProviderIds: string[]
  registeredProviderConfigs: Record<string, unknown>
  authChecks: Record<string, unknown>
  error?: string
}

export type ProviderAuthEventV1 =
  | {
      type: "prompt"
      flowId: string
      promptId: string
      providerId: string
      prompt: {
        type: "text" | "secret" | "select" | "manual_code"
        message: string
        placeholder?: string
        options?: Array<{ id: string; label: string; description?: string }>
      }
    }
  | { type: "notification"; flowId: string; providerId: string; event: unknown }
  | { type: "completed"; flowId: string; providerId: string }
  | { type: "failed"; flowId: string; providerId: string; message: string }
  | { type: "cancelled"; flowId: string; providerId: string }

export interface ConfiguredPackageV1 {
  source: string
  scope: "user" | "project"
  filtered: boolean
  installedPath?: string
}

export interface ResolvedPackageResourceV1 {
  path: string
  enabled: boolean
  metadata: { source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; baseDir?: string }
}

export interface ResolvedPackageResourcesV1 {
  extensions: ResolvedPackageResourceV1[]
  skills: ResolvedPackageResourceV1[]
  prompts: ResolvedPackageResourceV1[]
  themes: ResolvedPackageResourceV1[]
}

export interface PackageUpdateV1 {
  source: string
  displayName: string
  type: "npm" | "git"
  scope: "user" | "project"
}

export interface PackageProgressV1 {
  commandId: string
  workspacePath?: string
  type: "start" | "progress" | "complete" | "error"
  action: "install" | "remove" | "update" | "clone" | "pull"
  source: string
  message?: string
}

export interface PiResourceDiagnosticV1 {
  type: "warning" | "error" | "collision"
  message: string
  path?: string
  collision?: unknown
}

export interface PiResourceSnapshotV1 {
  extensions: Array<{ path: string; resolvedPath: string; hidden?: boolean; sourceInfo?: unknown }>
  extensionErrors: Array<{ path: string; error: string }>
  skills: Array<{
    name: string
    description: string
    filePath: string
    baseDir: string
    disableModelInvocation: boolean
    sourceInfo?: unknown
  }>
  prompts: Array<{
    name: string
    description: string
    argumentHint?: string
    content: string
    filePath: string
    sourceInfo?: unknown
  }>
  themes: Array<{ name?: string; sourcePath?: string; sourceInfo?: unknown }>
  agentsFiles: Array<{ path: string; content: string }>
  systemPrompt?: string
  appendSystemPrompt: string[]
  diagnostics: PiResourceDiagnosticV1[]
  runtimeDiagnostics: Array<{ type: "info" | "warning" | "error"; message: string }>
  modelFallbackMessage?: string
}

export interface PiResourceExtensionPathsV1 {
  skillPaths?: Array<{ path: string; metadata: ResolvedPackageResourceV1["metadata"] }>
  promptPaths?: Array<{ path: string; metadata: ResolvedPackageResourceV1["metadata"] }>
  themePaths?: Array<{ path: string; metadata: ResolvedPackageResourceV1["metadata"] }>
}

export interface PiRuntimeInspectionV1 {
  header: unknown
  entries: unknown[]
  branch: unknown[]
  contextEntries: unknown[]
  context: unknown
  agentMessages: unknown[]
  lastAssistantText?: string
  userMessagesForForking: unknown[]
}
