/**
 * Safe git helpers — spawn only, no shell string concat.
 */
import { spawn } from "node:child_process"
import type {
  GitDiffItemV1,
  GitDiffResponseV1,
  GitInfoResponseV1,
  GitStatusItemV1,
  GitStatusResponseV1,
} from "@piui/protocol"

const TIMEOUT_MS = 15_000
const MAX_OUT = 2 * 1024 * 1024

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      if (!settled) {
        settled = true
        reject(new Error("git timeout"))
      }
    }, TIMEOUT_MS)

    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < MAX_OUT) stdout += c.toString("utf8")
    })
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < MAX_OUT) stderr += c.toString("utf8")
    })
    child.on("error", err => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    child.on("close", code => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        resolve({ code: code ?? 1, stdout, stderr })
      }
    })
  })
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])
    return r.code === 0 && r.stdout.trim() === "true"
  } catch {
    return false
  }
}

export async function getGitInfo(cwd: string): Promise<GitInfoResponseV1> {
  if (!(await isGitRepo(cwd))) {
    return { branch: null, root: false, ahead: 0, behind: 0 }
  }
  const branchR = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  const branch = branchR.code === 0 ? branchR.stdout.trim() || null : null
  let ahead = 0
  let behind = 0
  try {
    const ab = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    if (ab.code === 0) {
      const parts = ab.stdout.trim().split(/\s+/)
      behind = Number(parts[0] || 0) || 0
      ahead = Number(parts[1] || 0) || 0
    }
  } catch {
    /* no upstream */
  }
  return { branch, root: true, ahead, behind }
}

/** Parse porcelain v1 short status lines. */
export function parsePorcelainStatus(stdout: string): GitStatusItemV1[] {
  const items: GitStatusItemV1[] = []
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let filePath = line.slice(3)
    // rename: "R  old -> new"
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop()!.trim()
    }
    filePath = filePath.replace(/\\/g, "/").replace(/"/g, "")
    if (!filePath) continue
    items.push({ path: filePath, status: mapXy(xy) })
  }
  return items
}

function mapXy(xy: string): GitStatusItemV1["status"] {
  const x = xy[0] ?? " "
  const y = xy[1] ?? " "
  if (x === "?" || y === "?") return "added"
  if (x === "A" || y === "A") return "added"
  if (x === "D" || y === "D") return "deleted"
  if (x === "M" || y === "M" || x === "R" || y === "R" || x === "C" || y === "C") return "modified"
  if (x === "U" || y === "U") return "modified"
  return "unknown"
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponseV1> {
  const info = await getGitInfo(cwd)
  if (!info.root) {
    return { branch: null, ahead: 0, behind: 0, items: [] }
  }
  const r = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all", "-z"])
  if (r.code !== 0) {
    // fallback non-null
    const r2 = await runGit(cwd, ["status", "--porcelain", "--untracked-files=all"])
    return {
      branch: info.branch,
      ahead: info.ahead,
      behind: info.behind,
      items: parsePorcelainStatus(r2.stdout),
    }
  }
  // -z uses NUL separators; convert to lines for parser
  const lines = r.stdout
    .split("\0")
    .filter(Boolean)
    .map(entry => {
      // entry like " M path" or "R  old" then next is new path for rename - simplified
      if (entry.length >= 3) return entry.slice(0, 2) + " " + entry.slice(3)
      return entry
    })
    .join("\n")
  return {
    branch: info.branch,
    ahead: info.ahead,
    behind: info.behind,
    items: parsePorcelainStatus(lines),
  }
}

export async function getGitDiff(cwd: string, mode: "git" | "branch"): Promise<GitDiffResponseV1> {
  if (!(await isGitRepo(cwd))) return { mode, files: [] }

  const args =
    mode === "branch"
      ? ["diff", "--numstat", "--no-ext-diff", "origin/HEAD...HEAD"]
      : ["diff", "--numstat", "--no-ext-diff", "HEAD"]

  // working tree vs index+HEAD for "git" mode: include unstaged + staged
  const files: GitDiffItemV1[] = []
  if (mode === "git") {
    const unstaged = await runGit(cwd, ["diff", "--numstat", "--no-ext-diff"])
    const staged = await runGit(cwd, ["diff", "--numstat", "--no-ext-diff", "--cached"])
    const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"])
    mergeNumstat(files, unstaged.stdout)
    mergeNumstat(files, staged.stdout)
    for (const p of untracked.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
      const path = p.replace(/\\/g, "/")
      if (!files.some(f => f.file === path)) {
        files.push({ file: path, status: "added", additions: 0, deletions: 0 })
      }
    }
  } else {
    let r = await runGit(cwd, args)
    if (r.code !== 0) {
      // try main/master
      r = await runGit(cwd, ["diff", "--numstat", "--no-ext-diff", "main...HEAD"])
      if (r.code !== 0) {
        r = await runGit(cwd, ["diff", "--numstat", "--no-ext-diff", "master...HEAD"])
      }
    }
    mergeNumstat(files, r.stdout)
  }

  return { mode, files }
}

function mergeNumstat(files: GitDiffItemV1[], stdout: string) {
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    const additions = m[1] === "-" ? 0 : Number(m[1])
    const deletions = m[2] === "-" ? 0 : Number(m[2])
    const file = m[3].replace(/\\/g, "/")
    const existing = files.find(f => f.file === file)
    if (existing) {
      existing.additions += additions
      existing.deletions += deletions
      continue
    }
    let status: GitDiffItemV1["status"] = "modified"
    if (additions > 0 && deletions === 0) status = "added"
    if (additions === 0 && deletions > 0) status = "deleted"
    files.push({ file, status, additions, deletions })
  }
}
