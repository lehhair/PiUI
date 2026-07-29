import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type {
  GitDiffItem,
  GitDiffMode,
  GitDiffResponse,
  GitFileDiffResponse,
  GitFileStatus,
  GitInfoResponse,
  GitStatusItem,
  GitStatusResponse,
} from "@piui/protocol"
import { normalizeRelativePath } from "./path-safety.ts"

const TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const CACHE_MS = 250
const MAX_CONCURRENT_GIT = 4
const cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>()
const completedCache = new Map<string, { expiresAt: number; value: unknown }>()
let activeGitCommands = 0
const gitWaiters: Array<() => void> = []

interface GitResult {
  code: number
  stdout: Buffer
  stderr: Buffer
}

function runGit(
  cwd: string,
  args: string[],
  options: { signal?: AbortSignal; maxOutputBytes?: number } = {},
): Promise<GitResult> {
  return withGitSlot(options.signal, () => new Promise((resolve, reject) => {
    const child = spawn("git", [
      "--literal-pathspecs",
      "-c", "core.fsmonitor=false",
      "-c", "diff.external=",
      "-c", "diff.trustExitCode=false",
      ...args,
    ], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeGitEnv(),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      terminate(child)
      reject(error)
    }
    const onAbort = () => finishError(Object.assign(new Error("git request cancelled"), { code: "REQUEST_ABORTED" }))
    const timer = setTimeout(() => {
      finishError(Object.assign(new Error("git command timed out"), { code: "GIT_TIMEOUT" }))
    }, TIMEOUT_MS)
    timer.unref()
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (options.signal?.aborted) return onAbort()

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutput) {
        finishError(Object.assign(new Error("git output exceeded the remote API limit"), { code: "GIT_OUTPUT_LIMIT" }))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= maxOutput) stderr.push(chunk)
    })
    child.on("error", finishError)
    child.on("close", code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  }))
}

export async function isGitRepo(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { signal })
  return result.code === 0 && text(result.stdout).trim() === "true"
}

export function getGitInfo(cwd: string, signal?: AbortSignal): Promise<GitInfoResponse> {
  return cachedResult(cwd, "info", signal, () => loadGitInfo(cwd, signal))
}

async function loadGitInfo(cwd: string, signal?: AbortSignal): Promise<GitInfoResponse> {
  if (!(await isGitRepo(cwd, signal))) return emptyInfo()
  const [rootResult, branchResult, oidResult, upstreamResult, originHeadResult] = await Promise.all([
    runGit(cwd, ["rev-parse", "--show-toplevel"], { signal }),
    runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal }),
    runGit(cwd, ["rev-parse", "--verify", "HEAD"], { signal }),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { signal }),
    runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { signal }),
  ])
  const symbolicBranch = successText(branchResult)
  const headOid = successText(oidResult)
  const upstream = successText(upstreamResult)
  const detached = !symbolicBranch && Boolean(headOid)
  const unborn = Boolean(symbolicBranch) && !headOid
  const branch = symbolicBranch || (detached ? null : null)
  let defaultBranch = successText(originHeadResult)?.replace(/^origin\//, "")
  if (!defaultBranch) defaultBranch = await localDefaultBranch(cwd, signal)

  let ahead = 0
  let behind = 0
  if (upstream && headOid) {
    const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`], { signal })
    if (counts.code === 0) {
      const [behindText, aheadText] = text(counts.stdout).trim().split(/\s+/)
      behind = Number(behindText) || 0
      ahead = Number(aheadText) || 0
    }
  }
  return {
    branch,
    root: true,
    rootPath: successText(rootResult),
    headOid: headOid || undefined,
    detached,
    unborn,
    upstream: upstream || undefined,
    defaultBranch: defaultBranch || undefined,
    ahead,
    behind,
  }
}

export function parsePorcelainStatus(stdout: string): GitStatusItem[] {
  return stdout.includes("\0") ? parsePorcelainStatusZ(stdout) : parsePorcelainLines(stdout)
}

export function parsePorcelainStatusZ(stdout: string): GitStatusItem[] {
  const records = stdout.split("\0")
  const items: GitStatusItem[] = []
  for (let index = 0; index < records.length;) {
    const record = records[index++]
    if (!record || record.length < 3) continue
    const xy = record.slice(0, 2)
    const path = normalizeGitPath(record.slice(3))
    let oldPath: string | undefined
    if (xy.includes("R") || xy.includes("C")) oldPath = normalizeGitPath(records[index++] ?? "")
    if (path) items.push(statusItem(path, xy, oldPath))
  }
  return items
}

function parsePorcelainLines(stdout: string): GitStatusItem[] {
  return stdout.split(/\r?\n/).flatMap(line => {
    if (line.length < 4) return []
    const xy = line.slice(0, 2)
    const raw = line.slice(3)
    const split = (xy.includes("R") || xy.includes("C")) ? raw.lastIndexOf(" -> ") : -1
    const oldPath = split >= 0 ? normalizeGitPath(raw.slice(0, split)) : undefined
    const filePath = normalizeGitPath(split >= 0 ? raw.slice(split + 4) : raw)
    return filePath ? [statusItem(filePath, xy, oldPath)] : []
  })
}

export function getGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  const load = async () => {
    const info = await getGitInfo(cwd, signal)
    if (!info.root) return { branch: null, ahead: 0, behind: 0, items: [] }
    const result = await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], { signal })
    assertGitSuccess(result, "git status")
    return {
      branch: info.branch,
      ahead: info.ahead,
      behind: info.behind,
      items: parsePorcelainStatusZ(text(result.stdout)),
    }
  }
  return cachedResult(cwd, "status", signal, load)
}

export function getGitDiff(cwd: string, mode: GitDiffMode, signal?: AbortSignal): Promise<GitDiffResponse> {
  const load = async () => {
    const info = await getGitInfo(cwd, signal)
    if (!info.root) return { mode, files: [] }
    const comparison = await comparisonForMode(cwd, mode, info, signal)
    const common = ["--no-ext-diff", "--no-textconv", ...comparison.args, "--"]
    const [namesResult, numbersResult] = await Promise.all([
      runGit(cwd, ["diff", "--name-status", "-z", "-M", ...common], { signal }),
      runGit(cwd, ["diff", "--numstat", "-z", "-M", ...common], { signal }),
    ])
    assertGitSuccess(namesResult, "git diff --name-status")
    assertGitSuccess(numbersResult, "git diff --numstat")
    const files = combineDiff(text(namesResult.stdout), text(numbersResult.stdout))
    if (mode === "git") {
      const status = await getGitStatus(cwd, signal)
      const missing = status.items.filter(item =>
        item.status === "untracked" && !files.some(file => file.file === item.path))
      const extras = await Promise.all(missing.map(async item => ({
        file: item.path,
        status: "untracked" as const,
        ...(await countUntrackedStats(cwd, item.path, signal)),
      })))
      files.push(...extras)
    }
    files.sort((a, b) => a.file.localeCompare(b.file))
    return { mode, baseRef: comparison.baseRef, baseCommit: comparison.baseCommit, files }
  }
  return cachedResult(cwd, `diff:${mode}`, signal, load)
}

const MAX_UNTRACKED_STAT_BYTES = 32 * 1024 * 1024

function cancelledError(): Error {
  return Object.assign(new Error("git request cancelled"), { code: "REQUEST_ABORTED" })
}

// untracked 文件不在 git diff 输出里，统计等价于“整文件新增”
async function countUntrackedStats(
  cwd: string,
  relative: string,
  signal?: AbortSignal,
): Promise<{ additions: number; deletions: number; binary: boolean }> {
  try {
    if (signal?.aborted) throw cancelledError()
    const absolute = path.join(cwd, relative)
    const stat = await fs.stat(absolute)
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_STAT_BYTES) {
      return { additions: 0, deletions: 0, binary: false }
    }
    const content = await fs.readFile(absolute)
    if (signal?.aborted) throw cancelledError()
    if (content.subarray(0, 8000).includes(0)) {
      return { additions: 0, deletions: 0, binary: true }
    }
    if (content.length === 0) return { additions: 0, deletions: 0, binary: false }
    let lines = 0
    for (const byte of content) {
      if (byte === 0x0a) lines += 1
    }
    if (content[content.length - 1] !== 0x0a) lines += 1
    return { additions: lines, deletions: 0, binary: false }
  } catch (error) {
    if ((error as { code?: string }).code === "REQUEST_ABORTED") throw error
    return { additions: 0, deletions: 0, binary: false }
  }
}

export async function getGitFileDiff(
  cwd: string,
  mode: GitDiffMode,
  filePath: string,
  signal?: AbortSignal,
): Promise<GitFileDiffResponse> {
  const relative = normalizeRelativePath(filePath)
  if (!relative) throw Object.assign(new Error("file path required"), { code: "INVALID_REQUEST" })
  const diff = await getGitDiff(cwd, mode, signal)
  const item = diff.files.find(candidate => candidate.file === relative)
  if (!item) throw Object.assign(new Error("file is not part of this diff"), { code: "NOT_FOUND" })
  let result: GitResult
  if (item.status === "untracked") {
    result = await runGit(cwd, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", relative], {
      signal,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    if (result.code !== 0 && result.code !== 1) assertGitSuccess(result, "git diff --no-index")
  } else {
    const info = await getGitInfo(cwd, signal)
    const comparison = await comparisonForMode(cwd, mode, info, signal)
    const paths = item.oldPath ? [item.oldPath, item.file] : [item.file]
    result = await runGit(cwd, [
      "diff", "--patch", "--no-color", "--no-ext-diff", "--no-textconv", "-M", ...comparison.args, "--", ...paths,
    ], { signal, maxOutputBytes: MAX_OUTPUT_BYTES })
    assertGitSuccess(result, "git file diff")
  }
  const patch = text(result.stdout)
  return { ...item, mode, patch, truncated: false, binary: item.binary || /Binary files .* differ/.test(patch) }
}

export function invalidateGitCache(cwd?: string): void {
  if (!cwd) {
    cache.clear()
    completedCache.clear()
    return
  }
  const prefix = `${path.resolve(cwd)}\0`
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
  for (const key of completedCache.keys()) if (key.startsWith(prefix)) completedCache.delete(key)
}

function combineDiff(nameStatus: string, numstat: string): GitDiffItem[] {
  const numbers = parseNumstatZ(numstat)
  return parseNameStatusZ(nameStatus).map(item => {
    const number = numbers.get(item.file)
    return {
      ...item,
      additions: number?.additions ?? 0,
      deletions: number?.deletions ?? 0,
      binary: number?.binary ?? false,
    }
  })
}

function parseNameStatusZ(stdout: string): Array<Pick<GitDiffItem, "file" | "oldPath" | "status">> {
  const tokens = stdout.split("\0")
  const items: Array<Pick<GitDiffItem, "file" | "oldPath" | "status">> = []
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++]
    if (!code) continue
    const kind = code[0] ?? "M"
    if (kind === "R" || kind === "C") {
      const oldPath = normalizeGitPath(tokens[index++] ?? "")
      const file = normalizeGitPath(tokens[index++] ?? "")
      if (file) items.push({ file, oldPath: oldPath || undefined, status: kind === "R" ? "renamed" : "copied" })
      continue
    }
    const file = normalizeGitPath(tokens[index++] ?? "")
    if (file) items.push({ file, status: diffStatus(kind) })
  }
  return items
}

export function parseNumstatZ(stdout: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = stdout.split("\0")
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++]
    if (!token) continue
    const firstTab = token.indexOf("\t")
    const secondTab = firstTab < 0 ? -1 : token.indexOf("\t", firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const added = token.slice(0, firstTab)
    const deleted = token.slice(firstTab + 1, secondTab)
    const filePart = token.slice(secondTab + 1)
    let file = filePart
    if (!filePart) {
      index++ // old path for rename/copy
      file = tokens[index++] ?? ""
    }
    file = normalizeGitPath(file)
    if (!file) continue
    result.set(file, {
      additions: added === "-" ? 0 : Number(added) || 0,
      deletions: deleted === "-" ? 0 : Number(deleted) || 0,
      binary: added === "-" || deleted === "-",
    })
  }
  return result
}

async function comparisonForMode(
  cwd: string,
  mode: GitDiffMode,
  info: GitInfoResponse,
  signal?: AbortSignal,
): Promise<{ args: string[]; baseRef?: string; baseCommit?: string }> {
  if (mode === "staged") return { args: ["--cached"] }
  if (mode === "unstaged") return { args: [] }
  if (mode === "git") return info.unborn ? { args: ["--cached"] } : { args: ["HEAD"], baseRef: "HEAD", baseCommit: info.headOid }
  let baseRef: string | undefined
  if (info.defaultBranch) {
    for (const candidate of [`refs/remotes/origin/${info.defaultBranch}`, `refs/heads/${info.defaultBranch}`]) {
      const exists = await runGit(cwd, ["show-ref", "--verify", "--quiet", candidate], { signal })
      if (exists.code === 0) {
        baseRef = candidate
        break
      }
    }
  }
  baseRef ??= info.upstream
  if (!baseRef) throw Object.assign(new Error("no upstream or default branch is available for comparison"), { code: "GIT_BASE_NOT_FOUND" })
  const mergeBase = await runGit(cwd, ["merge-base", baseRef, "HEAD"], { signal })
  assertGitSuccess(mergeBase, "git merge-base")
  const baseCommit = successText(mergeBase)
  return { args: [`${baseRef}...HEAD`], baseRef, baseCommit: baseCommit || undefined }
}

function statusItem(filePath: string, xy: string, oldPath?: string): GitStatusItem {
  const indexStatus = xy[0] ?? " "
  const worktreeStatus = xy[1] ?? " "
  return {
    path: filePath,
    oldPath,
    status: statusFromXy(xy),
    indexStatus,
    worktreeStatus,
    staged: indexStatus !== " " && indexStatus !== "?",
    unstaged: worktreeStatus !== " ",
  }
}

function statusFromXy(xy: string): GitFileStatus {
  if (xy === "??") return "untracked"
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy)) return "conflicted"
  if (xy.includes("R")) return "renamed"
  if (xy.includes("C")) return "copied"
  if (xy.includes("A")) return "added"
  if (xy.includes("D")) return "deleted"
  if (xy.includes("M") || xy.includes("T")) return "modified"
  return "unknown"
}

function diffStatus(code: string): GitDiffItem["status"] {
  if (code === "A") return "added"
  if (code === "D") return "deleted"
  return "modified"
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, "/")
}

function safeGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" || key.startsWith("GIT_CONFIG_")) {
      delete env[key]
    }
  }
  env.GIT_OPTIONAL_LOCKS = "0"
  env.GIT_TERMINAL_PROMPT = "0"
  env.LC_ALL = "C.UTF-8"
  return env
}

function terminate(child: ReturnType<typeof spawn>): void {
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 1000)
  force.unref()
  child.once("close", () => clearTimeout(force))
}

function assertGitSuccess(result: GitResult, operation: string): void {
  if (result.code === 0) return
  const message = text(result.stderr).trim() || `${operation} failed with exit code ${result.code}`
  throw Object.assign(new Error(message), { code: "GIT_FAILED" })
}

function text(buffer: Buffer): string {
  return buffer.toString("utf8")
}

function successText(result: GitResult): string | undefined {
  return result.code === 0 ? text(result.stdout).trim() || undefined : undefined
}

async function localDefaultBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  for (const branch of ["main", "master"]) {
    const result = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { signal })
    if (result.code === 0) return branch
  }
  return undefined
}

function emptyInfo(): GitInfoResponse {
  return { branch: null, root: false, detached: false, unborn: false, ahead: 0, behind: 0 }
}

function cached<T>(cwd: string, operation: string, load: () => Promise<T>): Promise<T> {
  const key = `${path.resolve(cwd)}\0${operation}`
  const existing = cache.get(key)
  if (existing && existing.expiresAt > Date.now()) return existing.value as Promise<T>
  const value = load().catch(error => {
    if (cache.get(key)?.value === value) cache.delete(key)
    throw error
  })
  cache.set(key, { expiresAt: Date.now() + CACHE_MS, value })
  return value
}

function cachedResult<T>(
  cwd: string,
  operation: string,
  signal: AbortSignal | undefined,
  load: () => Promise<T>,
): Promise<T> {
  const key = `${path.resolve(cwd)}\0${operation}`
  const completed = completedCache.get(key)
  if (completed && completed.expiresAt > Date.now()) return Promise.resolve(completed.value as T)
  const store = () => load().then(value => {
    completedCache.set(key, { expiresAt: Date.now() + CACHE_MS, value })
    return value
  })
  return signal ? store() : cached(cwd, operation, store)
}

async function withGitSlot<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (activeGitCommands >= MAX_CONCURRENT_GIT) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        const index = gitWaiters.indexOf(wake)
        if (index >= 0) gitWaiters.splice(index, 1)
        reject(Object.assign(new Error("git request cancelled"), { code: "REQUEST_ABORTED" }))
      }
      gitWaiters.push(wake)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  activeGitCommands++
  try {
    return await operation()
  } finally {
    activeGitCommands--
    gitWaiters.shift()?.()
  }
}
