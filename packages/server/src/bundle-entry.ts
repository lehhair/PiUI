/**
 * Public executable entry. The first argument is the mode selector; all other
 * arguments are left untouched for the native Pi CLI.
 */
const { dirname, join } = await import("node:path")
const { existsSync } = await import("node:fs")
// 原生/运行时模块（node-pty、jiti）从 exe 旁的 node_modules 按绝对路径加载；
// 旁边没有（安装目录里只有 zip）时退回 Tauri 壳解压到应用数据目录的位置
const execDir = dirname(process.execPath)
const launchDir = process.cwd()
const isWorker = process.argv[2] === "--pi-worker"
const isWeb = process.argv[2] === "web"

if (isWeb && !process.env.PIUI_NATIVE_MODULES) {
  let nativeDir = [execDir, launchDir]
    .map(dir => join(dir, "node_modules"))
    .find(dir => existsSync(dir))
  if (!nativeDir) {
    const home = process.platform === "win32" ? process.env.APPDATA : process.env.HOME
    if (home) {
      const appDataNative = process.platform === "win32"
        ? join(home, "com.piui.desktop", "node_modules")
        : process.platform === "darwin"
          ? join(home, "Library", "Application Support", "com.piui.desktop", "node_modules")
          : join(process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "com.piui.desktop", "node_modules")
      if (existsSync(appDataNative)) nativeDir = appDataNative
    }
  }
  if (nativeDir) process.env.PIUI_NATIVE_MODULES = nativeDir
}

if (isWorker) {
  // 用相对路径指向已构建的 worker 产物：Bun 打包时包名（workspace）内的
  // 动态 import SDK 不会内联（Cannot find module），相对路径能正确打包。
  // 指向 dist 而非 src，避免 tsc rootDir 把 pi-worker 源文件拉进 server 编译。
  await import("../../pi-worker/dist/entry.js")
} else if (isWeb) {
  // Bun builds cannot fork a TypeScript entry, so the server respawns this
  // executable with --pi-worker. Node development keeps using child_process.fork.
  if (process.versions.bun) process.env.PIUI_WORKER_SELF = "1"
  process.env.PIUI_DRIVER ??= "pi"
  const { parseWebArgs, printWebHelp, startPiUiServer } = await import("./start.ts")
  const { help, ...options } = parseWebArgs(process.argv.slice(3))
  if (help) {
    printWebHelp()
  } else {
    await startPiUiServer(options)
  }
} else if (process.versions.bun) {
  await import("./pi-cli-bun-entry.js")
} else {
  await import("./pi-cli-entry.js")
}
