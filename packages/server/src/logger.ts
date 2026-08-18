/**
 * 服务端文件日志：把关键日志主动追加写入磁盘文件。
 *
 * 为什么必须主动写而不是捕获 console：桌面壳（Tauri）启动 pi-worker.exe
 * 时 stdout/stderr 是 piped 到内存环形缓冲（只有最近 24 行），进程退出后
 * 全部丢失。而 monkey-patch process.stdout.write 在 bun 下无效——bun 的
 * console.log 直接写底层 fd，不走 JS 层方法（实测 captured=0）。所以这里
 * 提供显式的 logToFile()，由关键日志点（worker 崩溃、启动、shutdown）直接
 * 调用；node 模式下仍附加 console 捕获以覆盖未被显式记录的零散输出。
 *
 * 文件位置：<piui 数据目录>/logs/piui-server-YYYY-MM-DD.log
 * 按天轮转，保留最近 N 天（PIUI_LOG_KEEP_DAYS，默认 7）。
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

let logDir: string | undefined
let logFile: string | undefined
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
    if (logFile && currentDay === day) return logFile
    currentDay = day
    if (!logDir) {
      logDir = join(dataRoot(), "logs")
      mkdirSync(logDir, { recursive: true })
    }
    logFile = join(logDir, `piui-server-${day}.log`)
    return logFile
  } catch {
    return undefined
  }
}

/**
 * 主动写一条日志。所有关键事件（启动、worker 崩溃、shutdown、错误）都应
 * 调用它——这是 bun 打包 exe 下唯一可靠的落盘方式。
 */
export function logToFile(message: string): void {
  if (!enabled) return
  const file = ensureLogFile()
  if (!file) return
  try {
    appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* 磁盘满/权限问题时不阻塞主流程 */
  }
}

export function logInfo(message: string): void {
  logToFile(message)
}

export function logError(message: string): void {
  logToFile(message)
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
 * 启用文件日志（幂等）。node 模式下额外 patch console 的 stdout/stderr 以
 * 捕获零散输出；bun 下 console 不走 JS 方法，依赖各日志点显式 logToFile。
 */
export function enableFileLogging(enable = process.env.PIUI_FILE_LOG !== "0"): () => void {
  if (enabled) return () => undefined
  if (!enable) return () => undefined
  enabled = true
  cleanupOldLogs()
  // node 模式下 console 走 process.stdout.write，patch 可捕获；
  // bun 下无效但无害（主动 logToFile 是主路径）。
  try {
    const origStdoutWrite = process.stdout.write.bind(process.stdout)
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") logToFile(chunk.replace(/\n$/, ""))
      return origStdoutWrite(chunk as never, ...(rest as never[]))
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") logToFile(chunk.replace(/\n$/, ""))
      return origStderrWrite(chunk as never, ...(rest as never[]))
    }) as typeof process.stderr.write
  } catch {
    /* ignore */
  }
  return () => {
    enabled = false
  }
}
