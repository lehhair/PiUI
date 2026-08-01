import { existsSync, promises as fs } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonObject, JsonValue } from "@piui/protocol"
import { requireJsonValue } from "@piui/protocol"
import type { SettingsManager } from "@earendil-works/pi-coding-agent"
import { getLoadedSdk } from "../sdk-host.js"
import type { CatalogProvider } from "../runtime.js"
import type { PackagesGateway } from "../command-table.js"

/**
 * Windows callers hand us backslash paths, but pi encodes the cwd into the
 * session folder name with forward slashes only — a backslash cwd makes pi
 * try to mkdir a nested folder and fail. Normalize once at the boundary.
 */
export function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/")
}

export function settingsForWorkspace(cwd: string, agentDir?: string) {
  const { SettingsManager, ProjectTrustStore, getAgentDir, hasTrustRequiringProjectResources } = getLoadedSdk().sdk
  const dir = agentDir ?? getAgentDir()
  const store = new ProjectTrustStore(dir)
  const manager = SettingsManager.create(normalizeCwd(cwd), dir, { projectTrusted: false })
  const required = hasTrustRequiringProjectResources(cwd)
  const decision = store.get(cwd)
  const defaultDecision = manager.getDefaultProjectTrust()
  const trusted = !required
    || decision === true
    || (decision === null && defaultDecision === "always")
  return {
    manager,
    trust: {
      workspacePath: cwd,
      required,
      decision,
      inheritedFrom: store.getEntry(cwd)?.path,
      defaultDecision,
      trusted: !required || (decision ?? defaultDecision === "always"),
    },
  }
}

export function configuredSessionDir(cwd: string, agentDir?: string): string {
  const { SettingsManager, getAgentDir } = getLoadedSdk().sdk
  const dir = agentDir ?? getAgentDir()
  const envSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (envSessionDir) return resolveUserPath(envSessionDir)
  const fromSettings = SettingsManager.create(normalizeCwd(cwd), dir, { projectTrusted: false }).getSessionDir()
  if (fromSettings) return fromSettings
  // SDK 未配置自定义 session 目录时 fallback 到其默认位置
  // (~/.pi/agent/sessions/<encoded-cwd>/)，保证 deleteSession 的围栏始终有真实根可查。
  const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  return path.join(path.resolve(dir), "sessions", safePath)
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (/^file:\/\//i.test(trimmed)) {
    return path.resolve(fileURLToPath(trimmed))
  }
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"))) {
    return path.resolve(homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

function packageManagerForWorkspace(cwd: string, agentDir?: string) {
  const { DefaultPackageManager, getAgentDir } = getLoadedSdk().sdk
  const { manager } = settingsForWorkspace(cwd, agentDir)
  return new DefaultPackageManager({ cwd, agentDir: agentDir ?? getAgentDir(), settingsManager: manager })
}

export class PiCatalog implements CatalogProvider, PackagesGateway {
  constructor(private readonly agentDir?: string) {}

  private dir(): string | undefined {
    return this.agentDir
  }

  async listSessions(cwd: string): Promise<JsonValue> {
    const { SessionManager } = getLoadedSdk().sdk
    const normalized = normalizeCwd(cwd)
    return requireJsonValue(await SessionManager.list(normalized, configuredSessionDir(normalized, this.dir())), "SESSION_LIST_NOT_JSON")
  }

  async listAllSessions(): Promise<JsonValue> {
    const { SessionManager } = getLoadedSdk().sdk
    return requireJsonValue(await SessionManager.listAll(configuredSessionDir(process.cwd(), this.dir())), "SESSION_LIST_NOT_JSON")
  }

  async deleteSession(cwd: string, sessionFile: string): Promise<void> {
    const target = resolveUserPath(sessionFile)
    const root = path.resolve(configuredSessionDir(cwd, this.dir()))
    const resolved = path.resolve(target)
    // Windows paths compare case-insensitively; a legal path differing only
    // in case must not be rejected (fails closed, but still a false 403).
    const rootKey = process.platform === "win32" ? root.toLowerCase() : root
    const resolvedKey = process.platform === "win32" ? resolved.toLowerCase() : resolved
    if (resolvedKey !== rootKey && !resolvedKey.startsWith(rootKey + path.sep)) {
      throw Object.assign(new Error("session file is outside the Pi session directory"), {
        code: "PATH_OUTSIDE_WORKSPACE",
      })
    }
    // 幂等：文件可能从未落盘（新会话首个条目才写文件），缺文件即视为已删
    if (!existsSync(target)) return
    await fs.unlink(target)
  }

  async listModels(): Promise<JsonValue> {
    const { ModelRuntime } = getLoadedSdk().sdk
    const runtime = await ModelRuntime.create({ allowModelNetwork: false })
    return requireJsonValue(await runtime.getAvailable(), "MODEL_LIST_NOT_JSON")
  }

  getSettings(cwd: string): JsonValue {
    const { manager, trust } = settingsForWorkspace(cwd, this.dir())
    return settingsSnapshot(cwd, manager, trust.trusted)
  }

  async patchSettings(cwd: string, patch: JsonObject): Promise<JsonValue> {
    const { applyHttpProxySettings } = getLoadedSdk().sdk
    const { manager, trust } = settingsForWorkspace(cwd, this.dir())
    applySettingsPatch(manager, patch)
    await manager.flush()
    if ("httpProxy" in patch) applyHttpProxySettings(manager.getHttpProxy())
    return settingsSnapshot(cwd, manager, trust.trusted)
  }

  getProjectTrust(cwd: string): JsonValue {
    const { trust } = settingsForWorkspace(cwd, this.dir())
    return requireJsonValue(trust)
  }

  setProjectTrust(cwd: string, decision: boolean | null): JsonValue {
    const { ProjectTrustStore, getAgentDir } = getLoadedSdk().sdk
    new ProjectTrustStore(this.dir() ?? getAgentDir()).set(cwd, decision)
    return this.getProjectTrust(cwd)
  }

  list(cwd: string): JsonValue {
    return requireJsonValue(packageManagerForWorkspace(cwd, this.dir()).listConfiguredPackages())
  }

  async manage(
    cwd: string,
    commandId: string,
    action: "install" | "remove" | "update",
    source: string | undefined,
    local = false,
    persist = true,
  ): Promise<JsonValue> {
    const { DefaultPackageManager, getAgentDir } = getLoadedSdk().sdk
    const { manager } = settingsForWorkspace(cwd, this.dir())
    const packages = new DefaultPackageManager({ cwd, agentDir: this.dir() ?? getAgentDir(), settingsManager: manager })
    packages.setProgressCallback(() => undefined)
    if (action === "install") {
      if (!source) throw Object.assign(new Error("package source required"), { code: "INVALID_REQUEST" })
      await (persist ? packages.installAndPersist(source, { local }) : packages.install(source, { local }))
    } else if (action === "remove") {
      if (!source) throw Object.assign(new Error("package source required"), { code: "INVALID_REQUEST" })
      if (persist) await packages.removeAndPersist(source, { local })
      else await packages.remove(source, { local })
    } else {
      await packages.update(source)
    }
    await manager.flush()
    return requireJsonValue(packages.listConfiguredPackages())
  }

  async resolve(cwd: string, missingAction: "install" | "skip" | "error" = "skip"): Promise<JsonValue> {
    return requireJsonValue(await packageManagerForWorkspace(cwd, this.dir()).resolve(async () => missingAction))
  }

  async resolveSources(cwd: string, sources: string[], local?: boolean, temporary?: boolean): Promise<JsonValue> {
    return requireJsonValue(await packageManagerForWorkspace(cwd, this.dir()).resolveExtensionSources(sources, { local, temporary }))
  }

  async changeSource(cwd: string, source: string, operation: "add" | "remove", local = false): Promise<JsonValue> {
    const { DefaultPackageManager, getAgentDir } = getLoadedSdk().sdk
    const { manager } = settingsForWorkspace(cwd, this.dir())
    const packages = new DefaultPackageManager({ cwd, agentDir: this.dir() ?? getAgentDir(), settingsManager: manager })
    const changed = operation === "add"
      ? packages.addSourceToSettings(source, { local })
      : packages.removeSourceFromSettings(source, { local })
    await manager.flush()
    return requireJsonValue({ changed, packages: packages.listConfiguredPackages() })
  }

  installedPath(cwd: string, source: string, scope: "user" | "project"): JsonValue {
    return requireJsonValue(packageManagerForWorkspace(cwd, this.dir()).getInstalledPath(source, scope) ?? null)
  }

  async checkUpdates(cwd: string): Promise<JsonValue> {
    return requireJsonValue(await packageManagerForWorkspace(cwd, this.dir()).checkForAvailableUpdates())
  }
}

function settingsSnapshot(cwd: string, manager: SettingsManager, trusted: boolean): JsonValue {
  return requireJsonValue({
    workspacePath: cwd,
    projectTrusted: trusted,
    global: manager.getGlobalSettings(),
    project: manager.getProjectSettings(),
    effective: {
      lastChangelogVersion: manager.getLastChangelogVersion(),
      sessionDir: manager.getSessionDir(),
      defaultProvider: manager.getDefaultProvider(),
      defaultModel: manager.getDefaultModel(),
      defaultThinkingLevel: manager.getDefaultThinkingLevel(),
      transport: manager.getTransport(),
      steeringMode: manager.getSteeringMode(),
      followUpMode: manager.getFollowUpMode(),
      theme: manager.getThemeSetting(),
      compaction: manager.getCompactionSettings(),
      branchSummary: manager.getBranchSummarySettings(),
      retry: manager.getRetrySettings(),
      providerRetry: manager.getProviderRetrySettings(),
      httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
      websocketConnectTimeoutMs: manager.getWebSocketConnectTimeoutMs(),
      httpProxy: manager.getHttpProxy(),
      externalEditor: manager.getExternalEditorCommand(),
      hideThinkingBlock: manager.getHideThinkingBlock(),
      showCacheMissNotices: manager.getShowCacheMissNotices(),
      shellPath: manager.getShellPath(),
      shellCommandPrefix: manager.getShellCommandPrefix(),
      quietStartup: manager.getQuietStartup(),
      defaultProjectTrust: manager.getDefaultProjectTrust(),
      npmCommand: manager.getNpmCommand(),
      enableAnalytics: manager.getEnableAnalytics(),
      trackingId: manager.getTrackingId(),
      enableInstallTelemetry: manager.getEnableInstallTelemetry(),
      collapseChangelog: manager.getCollapseChangelog(),
      enableSkillCommands: manager.getEnableSkillCommands(),
      packages: manager.getPackages(),
      extensionPaths: manager.getExtensionPaths(),
      skillPaths: manager.getSkillPaths(),
      promptTemplatePaths: manager.getPromptTemplatePaths(),
      themePaths: manager.getThemePaths(),
      showImages: manager.getShowImages(),
      imageWidthCells: manager.getImageWidthCells(),
      imageAutoResize: manager.getImageAutoResize(),
      blockImages: manager.getBlockImages(),
      enabledModels: manager.getEnabledModels(),
      thinkingBudgets: manager.getThinkingBudgets(),
      doubleEscapeAction: manager.getDoubleEscapeAction(),
      treeFilterMode: manager.getTreeFilterMode(),
      clearOnShrink: manager.getClearOnShrink(),
      showTerminalProgress: manager.getShowTerminalProgress(),
      showHardwareCursor: manager.getShowHardwareCursor(),
      editorPaddingX: manager.getEditorPaddingX(),
      outputPad: manager.getOutputPad(),
      autocompleteMaxVisible: manager.getAutocompleteMaxVisible(),
      codeBlockIndent: manager.getCodeBlockIndent(),
      warnings: manager.getWarnings(),
    },
    errors: manager.drainErrors().map(error => ({ scope: error.scope, message: error.error.message })),
  })
}

function applySettingsPatch(manager: SettingsManager, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "defaultModelAndProvider") {
      const pair = expectRecord(key, value)
      manager.setDefaultModelAndProvider(expectString("provider", pair.provider), expectString("model", pair.model))
    }
    else if (key === "lastChangelogVersion") manager.setLastChangelogVersion(expectString(key, value))
    else if (key === "defaultProvider") manager.setDefaultProvider(expectString(key, value))
    else if (key === "defaultModel") manager.setDefaultModel(expectString(key, value))
    else if (key === "defaultThinkingLevel") manager.setDefaultThinkingLevel(expectEnum(key, value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]))
    else if (key === "transport") manager.setTransport(expectEnum(key, value, ["auto", "sse", "websocket", "websocket-cached"]))
    else if (key === "steeringMode") manager.setSteeringMode(expectEnum(key, value, ["all", "one-at-a-time"]))
    else if (key === "followUpMode") manager.setFollowUpMode(expectEnum(key, value, ["all", "one-at-a-time"]))
    else if (key === "theme") manager.setTheme(expectString(key, value))
    else if (key === "compactionEnabled") manager.setCompactionEnabled(expectBoolean(key, value))
    else if (key === "retryEnabled") manager.setRetryEnabled(expectBoolean(key, value))
    else if (key === "httpIdleTimeoutMs") manager.setHttpIdleTimeoutMs(expectNonNegativeNumber(key, value))
    else if (key === "httpProxy") manager.setHttpProxy(expectOptionalString(key, value))
    else if (key === "hideThinkingBlock") manager.setHideThinkingBlock(expectBoolean(key, value))
    else if (key === "showCacheMissNotices") manager.setShowCacheMissNotices(expectBoolean(key, value))
    else if (key === "shellPath") manager.setShellPath(expectOptionalString(key, value))
    else if (key === "shellCommandPrefix") manager.setShellCommandPrefix(expectOptionalString(key, value))
    else if (key === "quietStartup") manager.setQuietStartup(expectBoolean(key, value))
    else if (key === "defaultProjectTrust") manager.setDefaultProjectTrust(expectEnum(key, value, ["always", "never", "ask"]))
    else if (key === "npmCommand") manager.setNpmCommand(expectOptionalStringArray(key, value))
    else if (key === "enableAnalytics") manager.setEnableAnalytics(expectBoolean(key, value))
    else if (key === "enableInstallTelemetry") manager.setEnableInstallTelemetry(expectBoolean(key, value))
    else if (key === "collapseChangelog") manager.setCollapseChangelog(expectBoolean(key, value))
    else if (key === "enableSkillCommands") manager.setEnableSkillCommands(expectBoolean(key, value))
    else if (key === "packages") manager.setPackages(expectPackageSources(key, value) as never)
    else if (key === "projectPackages") manager.setProjectPackages(expectPackageSources(key, value) as never)
    else if (key === "extensionPaths") manager.setExtensionPaths(expectStringArray(key, value))
    else if (key === "projectExtensionPaths") manager.setProjectExtensionPaths(expectStringArray(key, value))
    else if (key === "skillPaths") manager.setSkillPaths(expectStringArray(key, value))
    else if (key === "projectSkillPaths") manager.setProjectSkillPaths(expectStringArray(key, value))
    else if (key === "promptTemplatePaths") manager.setPromptTemplatePaths(expectStringArray(key, value))
    else if (key === "projectPromptTemplatePaths") manager.setProjectPromptTemplatePaths(expectStringArray(key, value))
    else if (key === "themePaths") manager.setThemePaths(expectStringArray(key, value))
    else if (key === "projectThemePaths") manager.setProjectThemePaths(expectStringArray(key, value))
    else if (key === "showImages") manager.setShowImages(expectBoolean(key, value))
    else if (key === "imageWidthCells") manager.setImageWidthCells(expectNumber(key, value))
    else if (key === "imageAutoResize") manager.setImageAutoResize(expectBoolean(key, value))
    else if (key === "blockImages") manager.setBlockImages(expectBoolean(key, value))
    else if (key === "enabledModels") manager.setEnabledModels(expectOptionalStringArray(key, value))
    else if (key === "doubleEscapeAction") manager.setDoubleEscapeAction(expectEnum(key, value, ["fork", "tree", "none"]))
    else if (key === "treeFilterMode") manager.setTreeFilterMode(expectEnum(key, value, ["default", "no-tools", "user-only", "labeled-only", "all"]))
    else if (key === "clearOnShrink") manager.setClearOnShrink(expectBoolean(key, value))
    else if (key === "showTerminalProgress") manager.setShowTerminalProgress(expectBoolean(key, value))
    else if (key === "showHardwareCursor") manager.setShowHardwareCursor(expectBoolean(key, value))
    else if (key === "editorPaddingX") manager.setEditorPaddingX(expectNumber(key, value))
    else if (key === "outputPad") manager.setOutputPad(expectOutputPad(key, value))
    else if (key === "autocompleteMaxVisible") manager.setAutocompleteMaxVisible(expectNumber(key, value))
    else if (key === "warnings") manager.setWarnings(expectWarnings(key, value))
    else throw Object.assign(new Error(`unsupported Pi setting: ${key}`), { code: "INVALID_REQUEST" })
  }
}

function expectString(key: string, value: unknown): string {
  if (typeof value !== "string") throw invalidSetting(key)
  return value
}

function expectOptionalString(key: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  return expectString(key, value)
}

function expectBoolean(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidSetting(key)
  return value
}

function expectNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidSetting(key)
  return value
}

function expectNonNegativeNumber(key: string, value: unknown): number {
  const result = expectNumber(key, value)
  if (result < 0) throw invalidSetting(key)
  return result
}

function expectEnum<T extends string>(key: string, value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw invalidSetting(key)
  return value as T
}

function expectOptionalStringArray(key: string, value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw invalidSetting(key)
  return value
}

function expectStringArray(key: string, value: unknown): string[] {
  const result = expectOptionalStringArray(key, value)
  if (!result) throw invalidSetting(key)
  return result
}

function expectRecord(key: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidSetting(key)
  return value as Record<string, unknown>
}

function expectPackageSources(key: string, value: unknown): unknown {
  if (!Array.isArray(value)) throw invalidSetting(key)
  for (const item of value) {
    if (typeof item === "string") continue
    const source = expectRecord(key, item)
    if (typeof source.source !== "string" || !source.source) throw invalidSetting(key)
    if (source.autoload !== undefined && typeof source.autoload !== "boolean") throw invalidSetting(key)
    for (const field of ["extensions", "skills", "prompts", "themes"] as const) {
      if (source[field] !== undefined) expectStringArray(key, source[field])
    }
    if (Object.keys(source).some(field => !["source", "autoload", "extensions", "skills", "prompts", "themes"].includes(field))) {
      throw invalidSetting(key)
    }
  }
  return value
}

function expectWarnings(key: string, value: unknown): { anthropicExtraUsage?: boolean } {
  const warnings = expectRecord(key, value)
  if (Object.keys(warnings).some(field => field !== "anthropicExtraUsage")) throw invalidSetting(key)
  if (warnings.anthropicExtraUsage !== undefined && typeof warnings.anthropicExtraUsage !== "boolean") {
    throw invalidSetting(key)
  }
  return warnings as { anthropicExtraUsage?: boolean }
}

function expectOutputPad(key: string, value: unknown): 0 | 1 {
  if (value !== 0 && value !== 1) throw invalidSetting(key)
  return value
}

function invalidSetting(key: string): Error {
  return Object.assign(new Error(`invalid Pi setting: ${key}`), { code: "INVALID_REQUEST" })
}
