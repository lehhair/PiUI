/**
 * 服务端文件日志：把所有 console 输出（含 [piui-worker] 前缀的 worker 日志，
 * 因为 worker 的 stderr 是 inherit 到 server 的）追加写入磁盘文件。
 *
 * 为什么需要：桌面壳（Tauri）启动 pi-worker.exe 时 stdout/stderr 是 piped
 * 到内存环形缓冲（只有最近 24 行），进程退出/崩溃后日志全部丢失——「worker
 * 突然死了」这种事故在界面上只留下一瞬间的痕迹，磁盘上什么都没有。这里把
 * 关键输出落盘，崩溃后可回溯。
 *
 * 文件位置：<piui 数据目录>/logs/piui-server-YYYY-MM-DD.log
 * 按天轮转，保留最近 N 天（PIUI_LOG_KEEP_DAYS，默认 7）。
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

let logDir: string | undefined
let logFile: string | undefined
let logStream: NodeJS.WritableStream | undefined
let currentDay = ""
let enabled = false

function dataRoot(): string {
  const env = process.env.PIUI_DATA_DIR?.trim()
  if (env) return resolve(env)
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "com.piui.desktop")
  return join(homedir(), ".piui")
}

function ensureLogFile(): string | undefined {
  try {
    const day = new Date().toISOString().slice(0, 10)
    if (logFile && currentDay === day && logStream) return logFile
    currentDay = day
    if (!logDir) {
      logDir = join(dataRoot(), "logs")
      mkdirSync(logDir, { recursive: true })
    }
    logFile = join(logDir, `piui-server-${day}.log`)
    // 每行独立 append，进程崩溃时最多丢最后一行（用不了 createWriteStream
    // 的缓冲，那会丢更多）。
    return logFile
  } catch {
    return undefined
  }
}

function writeLine(chunk: string): void {
  if (!enabled) return
  const file = ensureLogFile()
  if (!file) return
  try {
    appendFileSync(file, `[${new Date().toISOString()}] ${chunk}`)
  } catch {
    /* 磁盘满/权限问题时不阻塞主流程 */
  }
}

function cleanupOldLogs(): void {
  try {
    if (!logDir) return
    const keepDays = Number(process.env.PIUI_LOG_KEEP_DAYS ?? 7)
    const cutoff = Date.now() - (Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 7) * 24 * 60 * 60 * 1000
    for (const name of readdirSync(logDir)) {
      const full = join(logDir, name)
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * 启用文件日志。幂等；不传 enable 时默认启用（可被 PIUI_FILE_LOG=0 关闭）。
 * 在 server 任何 console 输出之前调用（startPiUiServer 开头）。
 */
export function enableFileLogging(enable = process.env.PIUI_FILE_LOG !== "0"): () => void {
  if (enabled) return () => undefined
  if (!enable) return () => undefined
  enabled = true
  cleanupOldLogs()
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  // 只捕获行尾（\n）的完整行；console.log/info/warn/error 每次调用都是整行。
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") writeLine(chunk)
    return origStdoutWrite(chunk as never, ...(rest as never[]))
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") writeLine(chunk)
    return origStderrWrite(chunk as never, ...(rest as never[]))
  }) as typeof process.stderr.write
  return () => {
    enabled = false
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
  }
}
