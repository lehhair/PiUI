import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import semver from "semver"
import { extractNpmTarball, verifyIntegrity } from "./untar.ts"

/**
 * pi runtime 热更新：从 npm registry 解析依赖闭包 → 下载 tarball → 解压成
 * 扁平 node_modules → 原子切换 current.json 指针。用户机器上不需要
 * node/npm，唯一依赖是网络。
 *
 * 布局：
 *   runtime/pi-0.82.0/node_modules/@earendil-works/pi-coding-agent/…
 *   runtime/current.json  { "dir": "pi-0.82.0", "version": "0.82.0" }
 */

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const SEED_PACKAGE = "@earendil-works/pi-coding-agent"
/** 解压 staging 目录和最终目录的前缀，也是 sdk-host 指针识别的名字 */
const DIR_PREFIX = "pi-"
const KEEP_VERSIONS = 2

export interface RegistryVersionInfo {
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dist: { tarball: string; integrity?: string }
}

export interface RegistryMetadata {
  "dist-tags"?: { latest?: string }
  versions: Record<string, RegistryVersionInfo>
}

export interface PlanEntry {
  name: string
  version: string
  tarball: string
  integrity?: string
}

export interface PiRuntimeStatus {
  runtimeDir: string
  currentVersion?: string
  latestVersion?: string
  updateAvailable: boolean
}

interface UpdaterOptions {
  runtimeDir: string
  registry?: string
  /** 锁定目标版本（PIUI_PI_VERSION）；不设就追 dist-tags.latest */
  pinnedVersion?: string
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

/** 解析依赖闭包：BFS 收集每个包的所有版本约束，取同时满足的最高版 */
export async function resolveInstallPlan(
  seed: { name: string; range: string },
  fetchMetadata: (name: string) => Promise<RegistryMetadata>,
): Promise<PlanEntry[]> {
  const ranges = new Map<string, Set<string>>()
  const resolved = new Map<string, RegistryVersionInfo>()
  const metadataCache = new Map<string, Promise<RegistryMetadata>>()
  const queue: string[] = [seed.name]
  let iterations = 0

  const metadataFor = (name: string) => {
    let cached = metadataCache.get(name)
    if (!cached) {
      cached = fetchMetadata(name)
      metadataCache.set(name, cached)
    }
    return cached
  }
  const addRange = (name: string, range: string) => {
    let set = ranges.get(name)
    if (!set) ranges.set(name, (set = new Set()))
    set.add(range)
  }
  addRange(seed.name, seed.range)

  while (queue.length > 0) {
    if (++iterations > 4000) {
      throw Object.assign(new Error("dependency resolution did not converge"), { code: "PI_RUNTIME_RESOLVE_FAILED" })
    }
    const name = queue.shift()!
    const allRanges = [...(ranges.get(name) ?? new Set(["*"]))]
    const metadata = await metadataFor(name)
    const satisfying = Object.keys(metadata.versions).filter(version =>
      allRanges.every(range => semver.satisfies(version, range)),
    )
    const best = satisfying.length > 0 ? semver.rsort(satisfying)[0] : undefined
    if (!best) {
      throw Object.assign(
        new Error(`no version of ${name} satisfies ${allRanges.join(" + ")}`),
        { code: "PI_RUNTIME_RESOLVE_FAILED" },
      )
    }
    if (resolved.get(name)?.version === best) continue
    resolved.set(name, metadata.versions[best]!)
    for (const [dep, depRange] of Object.entries(metadata.versions[best]!.dependencies ?? {})) {
      addRange(dep, depRange)
      queue.push(dep)
    }
  }

  return [...resolved.entries()].map(([name, info]) => ({
    name,
    version: info.version,
    tarball: info.dist.tarball,
    integrity: info.dist.integrity,
  }))
}

export class PiRuntimeUpdater {
  private readonly registry: string
  private readonly fetchImpl: typeof fetch
  private readonly log: (message: string) => void
  private running?: Promise<{ version: string }>

  constructor(private readonly options: UpdaterOptions) {
    this.registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "")
    this.fetchImpl = options.fetchImpl ?? fetch
    this.log = options.log ?? (message => console.info(`[pi-runtime] ${message}`))
  }

  private async fetchMetadata(name: string): Promise<RegistryMetadata> {
    const res = await this.fetchImpl(`${this.registry}/${name}`)
    if (!res.ok) throw new Error(`registry metadata ${name}: HTTP ${res.status}`)
    return (await res.json()) as RegistryMetadata
  }

  currentVersion(): string | undefined {
    const pointer = join(this.options.runtimeDir, "current.json")
    try {
      const parsed = JSON.parse(readFileSync(pointer, "utf8")) as { version?: unknown }
      return typeof parsed.version === "string" ? parsed.version : undefined
    } catch {
      return undefined
    }
  }

  async status(): Promise<PiRuntimeStatus> {
    const current = this.currentVersion()
    let latest: string | undefined
    try {
      const metadata = await this.fetchMetadata(SEED_PACKAGE)
      latest = this.options.pinnedVersion ?? metadata["dist-tags"]?.latest
    } catch {
      latest = undefined
    }
    return {
      runtimeDir: this.options.runtimeDir,
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: Boolean(latest && latest !== current),
    }
  }

  /** 并发调用共享同一次更新；完成后指针指向新版本，下次启动生效 */
  update(): Promise<{ version: string }> {
    this.running ??= this.doUpdate().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async doUpdate(): Promise<{ version: string }> {
    const metadata = await this.fetchMetadata(SEED_PACKAGE)
    const target = this.options.pinnedVersion ?? metadata["dist-tags"]?.latest
    if (!target) throw new Error("registry has no latest dist-tag for the pi package")

    this.log(`resolving ${SEED_PACKAGE}@${target} dependency closure`)
    const plan = await resolveInstallPlan(
      { name: SEED_PACKAGE, range: target },
      name => this.fetchMetadata(name),
    )
    this.log(`install plan: ${plan.length} packages`)

    const staging = join(this.options.runtimeDir, `.staging-${target}`)
    const finalDir = join(this.options.runtimeDir, `${DIR_PREFIX}${target}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })

    try {
      for (const entry of plan) {
        const res = await this.fetchImpl(entry.tarball)
        if (!res.ok) throw new Error(`tarball ${entry.name}: HTTP ${res.status}`)
        const tgz = Buffer.from(await res.arrayBuffer())
        if (!verifyIntegrity(tgz, entry.integrity)) {
          throw Object.assign(new Error(`integrity check failed for ${entry.name}@${entry.version}`), { code: "PI_RUNTIME_INTEGRITY" })
        }
        extractNpmTarball(tgz, join(staging, "node_modules", ...entry.name.split("/")))
      }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }

    rmSync(finalDir, { recursive: true, force: true })
    renameSync(staging, finalDir)
    writeFileSync(
      join(this.options.runtimeDir, "current.json"),
      JSON.stringify({ dir: `${DIR_PREFIX}${target}`, version: target }, null, 2),
    )
    this.pruneOldVersions(target)
    this.log(`pi runtime ${target} installed; takes effect on next start`)
    return { version: target }
  }

  /** 保留最近几个版本目录用于回滚，更老的清掉 */
  private pruneOldVersions(keep: string): void {
    let dirs: string[]
    try {
      dirs = readdirSync(this.options.runtimeDir)
    } catch {
      return
    }
    const versions = dirs
      .filter(dir => dir.startsWith(DIR_PREFIX) && dir !== ".staging")
      .map(dir => dir.slice(DIR_PREFIX.length))
      .filter(version => semver.valid(version))
      .sort(semver.rcompare)
    for (const version of versions.slice(KEEP_VERSIONS)) {
      if (version === keep) continue
      rmSync(join(this.options.runtimeDir, `${DIR_PREFIX}${version}`), { recursive: true, force: true })
    }
  }
}

/** 打包形态下的默认 runtime 目录：exe 旁边的 runtime/ */
export function defaultRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIUI_RUNTIME_DIR?.trim() || join(dirname(process.execPath), "runtime")
}

export function createPiRuntimeUpdater(env: NodeJS.ProcessEnv = process.env): PiRuntimeUpdater | undefined {
  const runtimeDir = defaultRuntimeDir(env)
  // 目录不存在说明不是打包形态（开发态 runtime 在仓库里也没有），不启用
  if (!existsSync(runtimeDir)) return undefined
  return new PiRuntimeUpdater({
    runtimeDir,
    pinnedVersion: env.PIUI_PI_VERSION?.trim() || undefined,
  })
}
