import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { PI_PARITY_SDK_VERSION } from "@piui/protocol"
import type * as PiSdkModule from "@earendil-works/pi-coding-agent"

const embeddedBundledSdkVersion = process.env.PIUI_BUNDLED_SDK_VERSION?.trim() || undefined

export type PiSdk = typeof PiSdkModule

export interface LoadedSdk {
  sdk: PiSdk
  version: string
  source: "bundled" | "external"
  verified: boolean
}

export interface LoadSdkOptions {
  sdkPath?: string
  strict?: boolean
}

let cached: LoadedSdk | undefined

export function shouldRequireVerifiedSdk(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIUI_SDK_STRICT !== "0"
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

/** pi SDK 的 npm 包名（历史包名也认，用户可能装的是旧的） */
export const PI_SDK_PACKAGE_NAMES = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"] as const
const PI_SDK_FAMILY = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
] as const

export interface SdkResolution {
  /** 解析到的 SDK 包目录；undefined 表示走内置 node_modules 兜底 */
  sdkPath?: string
  source: "env" | "global" | "runtime" | "bundled"
}

interface ResolveDeps {
  env: NodeJS.ProcessEnv
  /** 可执行文件所在目录（编译产物旁边就是 runtime/ 目录） */
  execDir: string
  exists: (path: string) => boolean
  npmRootGlobal: () => string | undefined
}

function sdkPackageDir(root: string, exists: (path: string) => boolean): string | undefined {
  for (const name of PI_SDK_PACKAGE_NAMES) {
    const dir = join(root, ...name.split("/"))
    if (exists(join(dir, "dist", "index.js")) && sdkFamilyCompatible(dir, exists)) return dir
  }
  return undefined
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

/**
 * 打包后的 runtime 目录布局：
 *   runtime/current.json  { "dir": "pi-0.81.1" }   ← 热更新器切换的指针
 *   runtime/pi-0.81.1/node_modules/@earendil-works/pi-coding-agent/…
 * 没有指针时退回 runtime/pi（打包脚本铺的初始版本，同样是 node_modules 布局）。
 */
function runtimeSdkPath(runtimeDir: string, exists: (path: string) => boolean): string | undefined {
  const pointerFile = join(runtimeDir, "current.json")
  if (exists(pointerFile)) {
    try {
      const pointer = JSON.parse(readFileSync(pointerFile, "utf8")) as { dir?: unknown }
      if (typeof pointer.dir === "string" && pointer.dir && !pointer.dir.includes("..")) {
        const dir = sdkPackageDir(join(runtimeDir, pointer.dir, "node_modules"), exists)
        if (dir) return dir
      }
    } catch {
      // 指针坏了就落到下一个候选——不能因为一个 JSON 把整个定位搞死
    }
  }
  return sdkPackageDir(join(runtimeDir, "pi", "node_modules"), exists)
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
 * Tauri 壳把 runtime 解压到应用数据目录（安装目录里只有 piui-runtime.zip）。
 * 裸跑安装目录里的 exe 时没有 PIUI_RUNTIME_DIR，按壳的约定位置再猜一次。
 */
function appDataRuntimeDir(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === "win32") {
    const appData = env.APPDATA
    return appData ? join(appData, "com.piui.desktop", "runtime") : undefined
  }
  const home = env.HOME
  if (!home) return undefined
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "com.piui.desktop", "runtime")
    : join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "com.piui.desktop", "runtime")
}

/**
 * SDK 定位顺序：
 *   1. PIUI_SDK_PATH 显式指定
 *   2. PIUI_USE_SYSTEM_PI=1 时使用用户全局 npm 安装的 Pi
 *   3. 随包分发或 Tauri 解压的 current runtime
 *   4. 没有可用内置 runtime 时回退用户全局 Pi
 *   5. undefined → 内置 node_modules（开发态兜底）
 */
export function resolvePiSdkPath(deps: ResolveDeps): SdkResolution {
  const explicit = deps.env.PIUI_SDK_PATH?.trim()
  if (explicit) return { sdkPath: explicit, source: "env" }

  const useSystemPi = deps.env.PIUI_USE_SYSTEM_PI === "1"
  const globalRoot = useSystemPi ? globalNpmRoot(deps) : undefined
  const globalSdk = globalRoot ? sdkPackageDir(globalRoot, deps.exists) : undefined
  if (globalSdk) return { sdkPath: globalSdk, source: "global" }

  const runtimeDir = deps.env.PIUI_RUNTIME_DIR?.trim() || join(deps.execDir, "runtime")
  const runtime = runtimeSdkPath(runtimeDir, deps.exists)
  if (runtime) return { sdkPath: runtime, source: "runtime" }

  const appDataDir = appDataRuntimeDir(deps.env)
  if (appDataDir) {
    const appDataRuntime = runtimeSdkPath(appDataDir, deps.exists)
    if (appDataRuntime) return { sdkPath: appDataRuntime, source: "runtime" }
  }

  const fallbackGlobalRoot = globalNpmRoot(deps)
  const fallbackGlobalSdk = fallbackGlobalRoot ? sdkPackageDir(fallbackGlobalRoot, deps.exists) : undefined
  if (fallbackGlobalSdk) return { sdkPath: fallbackGlobalSdk, source: "global" }

  return { source: "bundled" }
}

export function defaultSdkResolution(env: NodeJS.ProcessEnv = process.env): SdkResolution {
  return resolvePiSdkPath({
    env,
    execDir: dirname(process.execPath),
    exists: existsSync,
    npmRootGlobal: defaultNpmRootGlobal,
  })
}

/**
 * 外部 SDK 走 jiti 加载：它自己做 Node 语义的 node_modules 上溯解析，
 * 原生 import 在 bun 编译产物里解析不了磁盘模块的裸包名依赖。
 * 编译形态下 jiti 本体也要按绝对路径从 exe 旁的 node_modules 里请出来
 * ——bare specifier 在编译产物里同样不可靠。
 */
async function importExternalSdk(entry: string): Promise<PiSdk> {
  const nativeRoot = process.env.PIUI_NATIVE_MODULES?.trim()
  const createJiti = nativeRoot
    ? (await import(pathToFileURL(join(nativeRoot, "jiti", "lib", "jiti.mjs")).href) as typeof import("jiti")).createJiti
    : (await import("jiti")).createJiti
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
  const version = external
    ? (typeof sdk.VERSION === "string" ? sdk.VERSION : "unknown")
    : (embeddedBundledSdkVersion ?? (typeof sdk.VERSION === "string" ? sdk.VERSION : "unknown"))
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
      new Error(`Bundled Pi SDK ${version} does not match the verified parity version ${PI_PARITY_SDK_VERSION}`),
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
  cached = { sdk, version, source: external ? "external" : "bundled", verified }
  return cached
}

export function getLoadedSdk(): LoadedSdk {
  if (!cached) throw Object.assign(new Error("Pi SDK is not loaded yet"), { code: "DRIVER_UNAVAILABLE" })
  return cached
}
