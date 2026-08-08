import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import type * as PiSdkModule from "@earendil-works/pi-coding-agent"
import { BUNDLED_PI_SDK_VERSION } from "./bundled-sdk-version.js"

export type PiSdk = typeof PiSdkModule

export interface LoadedSdk {
  sdk: PiSdk
  builtinSlashCommands: Array<{ name: string; description?: string; argumentHint?: string }>
  version: string
  source: "bundled" | "external"
  verified: boolean
  /** Set by the worker entry when an external SDK failed to load and the
   * worker fell back to the bundled SDK. Surfaced through the hello/health
   * so the UI can report why the user-installed Pi is not in use. */
  fallbackFrom?: { source: "env" | "global" | "bundled"; message: string; code: string }
}

export interface LoadSdkOptions {
  sdkPath?: string
  strict?: boolean
}

let cached: LoadedSdk | undefined

export function shouldRequireVerifiedSdk(env: NodeJS.ProcessEnv = process.env): boolean {
  // Advisory by default: an external SDK of a different version is used with
  // a warning, and load failures fall back to the bundled SDK. Set
  // PIUI_SDK_STRICT=1 to require the exact verified parity version instead.
  return env.PIUI_SDK_STRICT === "1"
}

function resolveSdkEntry(sdkPath: string): string {
  const absolute = isAbsolute(sdkPath) ? sdkPath : resolve(sdkPath)
  if (!existsSync(absolute)) {
    throw Object.assign(new Error(`Pi SDK path does not exist: ${absolute}`), { code: "DRIVER_UNAVAILABLE" })
  }
  if (statSync(absolute).isDirectory()) {
    const entry = join(absolute, "dist", "index.js")
    if (!existsSync(entry)) {
      throw Object.assign(new Error(`Pi SDK entry not found at ${entry}`), { code: "DRIVER_UNAVAILABLE" })
    }
    return entry
  }
  return absolute
}

// ============================================
// SDK 自动定位
// ============================================

const PI_SDK_PACKAGE_NAME = "@earendil-works/pi-coding-agent"
const PI_SDK_FAMILY = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
] as const

export interface SdkResolution {
  /** 解析到的 SDK 包目录；undefined 表示使用编译进 worker 的 SDK */
  sdkPath?: string
  source: "env" | "global" | "bundled"
}

interface ResolveDeps {
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  npmRootGlobal: () => string | undefined
}

function sdkPackageDir(root: string, exists: (path: string) => boolean): string | undefined {
  const dir = join(root, ...PI_SDK_PACKAGE_NAME.split("/"))
  return exists(join(dir, "dist", "index.js")) && sdkFamilyCompatible(dir, exists) ? dir : undefined
}

function packageJsonPath(fromDir: string, packageName: string, exists: (path: string) => boolean): string | undefined {
  const segments = packageName.split("/")
  const candidates = [
    join(fromDir, "node_modules", ...segments, "package.json"),
    join(dirname(fromDir), ...segments, "package.json"),
    join(dirname(dirname(fromDir)), ...segments, "package.json"),
  ]
  return candidates.find(candidate => exists(candidate))
}

function packageVersion(packageJson: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown }
    return typeof value.version === "string" ? value.version : undefined
  } catch {
    return undefined
  }
}

function sdkFamilyCompatible(sdkDir: string, exists: (path: string) => boolean): boolean {
  const mainVersion = packageVersion(join(sdkDir, "package.json"))
  // Test doubles and legacy external SDKs may not expose package metadata.
  if (!mainVersion) return true
  for (const packageName of PI_SDK_FAMILY) {
    const packageJson = packageName === "@earendil-works/pi-coding-agent"
      ? join(sdkDir, "package.json")
      : packageJsonPath(sdkDir, packageName, exists)
    const version = packageJson ? packageVersion(packageJson) : undefined
    if (version && version !== mainVersion) return false
  }
  return true
}

function globalNpmRoot(deps: ResolveDeps): string | undefined {
  const cached = deps.npmRootGlobal()
  if (cached) return cached
  // 常见安装前缀直接猜，猜中了就不用 spawn npm（快而且离线可用）
  const candidates: string[] = []
  if (process.platform === "win32") {
    const appData = deps.env.APPDATA
    if (appData) candidates.push(join(appData, "npm", "node_modules"))
  } else {
    candidates.push("/usr/local/lib/node_modules", "/usr/lib/node_modules")
    const home = deps.env.HOME
    if (home) candidates.push(join(home, ".npm-global", "lib", "node_modules"))
  }
  return candidates.find(path => deps.exists(path))
}

function defaultNpmRootGlobal(): string | undefined {
  try {
    const command = process.platform === "win32" ? "npm.cmd" : "npm"
    const result = spawnSync(command, ["root", "-g"], { timeout: 3000, encoding: "utf8", windowsHide: true })
    const root = result.status === 0 ? result.stdout?.trim() : undefined
    return root || undefined
  } catch {
    return undefined
  }
}

/**
 * SDK 定位顺序：
 *   1. PIUI_SDK_PATH 显式指定
 *   2. PIUI_USE_SYSTEM_PI=1 时使用用户全局 npm 安装的 Pi
 *   3. undefined → 使用编译进 worker 的 SDK
 */
export function resolvePiSdkPath(deps: ResolveDeps): SdkResolution {
  const explicit = deps.env.PIUI_SDK_PATH?.trim()
  if (explicit) return { sdkPath: explicit, source: "env" }

  if (deps.env.PIUI_USE_SYSTEM_PI === "1") {
    const globalRoot = globalNpmRoot(deps)
    const globalSdk = globalRoot ? sdkPackageDir(globalRoot, deps.exists) : undefined
    if (!globalSdk) {
      throw Object.assign(new Error("PIUI_USE_SYSTEM_PI is enabled but the Pi SDK is not installed globally"), {
        code: "DRIVER_UNAVAILABLE",
      })
    }
    return { sdkPath: globalSdk, source: "global" }
  }

  return { source: "bundled" }
}

export function defaultSdkResolution(env: NodeJS.ProcessEnv = process.env): SdkResolution {
  return resolvePiSdkPath({
    env,
    exists: existsSync,
    npmRootGlobal: defaultNpmRootGlobal,
  })
}

/**
 * 外部 SDK 走编译进 worker 的 jiti，使用 Node 语义解析磁盘模块依赖。
 */
async function importExternalSdk(entry: string): Promise<PiSdk> {
  const { createJiti } = await import("jiti/static")
  // Bun enables native import probing by default. In a compiled executable
  // that probe resolves from Bun's virtual B:\~BUN\root path instead of the
  // external runtime directory. Force jiti's filesystem resolver for SDKs.
  const jiti = createJiti(pathToFileURL(entry).href, {
    moduleCache: false,
    tryNative: false,
    alias: runtimePackageAliases(entry),
  })
  return await jiti.import(entry) as PiSdk
}

const runtimeAliasCache = new Map<string, Record<string, string>>()

function runtimePackageAliases(entry: string): Record<string, string> {
  let packageRoot = dirname(entry)
  while (packageRoot !== dirname(packageRoot) && packageRoot.endsWith("node_modules") === false) {
    packageRoot = dirname(packageRoot)
  }
  const cachedAliases = runtimeAliasCache.get(packageRoot)
  if (cachedAliases) return cachedAliases

  const aliases: Record<string, string> = {}
  const visit = (directory: string) => {
    const packageJson = join(directory, "package.json")
    if (existsSync(packageJson)) {
      try {
        const metadata = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown }
        if (typeof metadata.name === "string" && !aliases[metadata.name]) aliases[metadata.name] = directory
      } catch {
        // Ignore an unrelated malformed package and keep loading the SDK.
      }
    }
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name === ".bin") continue
      const child = join(directory, name.name)
      if (name.name === "node_modules" || directory.endsWith("node_modules")) visit(child)
    }
  }

  if (existsSync(packageRoot)) visit(packageRoot)
  runtimeAliasCache.set(packageRoot, aliases)
  return aliases
}

export async function loadPiSdk(options: LoadSdkOptions = {}): Promise<LoadedSdk> {
  if (cached) return cached
  const external = options.sdkPath?.trim()
  if (external && !sdkFamilyCompatible(resolveSdkEntry(external).replace(/[\\/]dist[\\/]index\.js$/, ""), existsSync)) {
    throw Object.assign(new Error(`Pi SDK dependency family is inconsistent at ${external}`), {
      code: "PI_SDK_VERSION_MISMATCH",
    })
  }
  const sdk = external
    ? await importExternalSdk(resolveSdkEntry(external))
    : await import("@earendil-works/pi-coding-agent") as PiSdk
  const sdkEntry = external
    ? resolveSdkEntry(external)
    : fileURLToPath(import.meta.resolve(PI_SDK_PACKAGE_NAME))
  const slashCommands = await import(pathToFileURL(join(dirname(sdkEntry), "core/slash-commands.js")).href) as {
    BUILTIN_SLASH_COMMANDS?: Array<{ name?: unknown; description?: unknown; argumentHint?: unknown }>
  }
  const builtinSlashCommands = (slashCommands.BUILTIN_SLASH_COMMANDS ?? [])
    .filter(command => typeof command.name === "string")
    .map(command => ({
      name: command.name as string,
      ...(typeof command.description === "string" ? { description: command.description } : {}),
      ...(typeof command.argumentHint === "string" ? { argumentHint: command.argumentHint } : {}),
    }))
  const version = typeof sdk.VERSION === "string" && sdk.VERSION
    ? sdk.VERSION
    : external ? "unknown" : BUNDLED_PI_SDK_VERSION
  const runtimeContract = sdk as PiSdk & {
    ModelRuntime?: { create?: unknown }
    SettingsManager?: unknown
    SessionManager?: unknown
  }
  if (
    typeof runtimeContract.ModelRuntime?.create !== "function" ||
    !runtimeContract.SettingsManager ||
    !runtimeContract.SessionManager
  ) {
    throw Object.assign(new Error(`Pi SDK ${version} does not expose the PiUI runtime contract`), {
      code: "PI_SDK_INCOMPATIBLE",
    })
  }
  const verified = version === PI_PARITY_SDK_VERSION
  if (!verified && !external) {
    throw Object.assign(
      new Error(
        `Bundled Pi SDK ${version} does not match the verified parity version ${PI_PARITY_SDK_VERSION}; ` +
        "update PI_PARITY_SDK_VERSION in packages/protocol/src/version.ts together with the dependency",
      ),
      { code: "PI_SDK_VERSION_MISMATCH" },
    )
  }
  if (!verified && external) {
    const message = `External Pi SDK ${version} is not the verified parity version ${PI_PARITY_SDK_VERSION}`
    if (options.strict) {
      throw Object.assign(new Error(message), { code: "PI_SDK_VERSION_MISMATCH" })
    }
    console.warn(`[piui-worker] ${message}; continuing because external SDKs are opt-in`)
  }
  cached = { sdk, builtinSlashCommands, version, source: external ? "external" : "bundled", verified }
  return cached
}

export function getLoadedSdk(): LoadedSdk {
  if (!cached) throw Object.assign(new Error("Pi SDK is not loaded yet"), { code: "DRIVER_UNAVAILABLE" })
  return cached
}
