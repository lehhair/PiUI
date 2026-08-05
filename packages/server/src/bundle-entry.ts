/**
 * 单文件可执行的统一入口：bun build --compile 把 server 和 pi-worker 打进
 * 同一个 exe，运行时靠参数分流——server 拉起 worker 时以 --pi-worker 再
 * 起一个自己（见 worker-client.ts 的 PIUI_WORKER_SELF 分支）。
 */
const { dirname, join } = await import("node:path")
const { existsSync, readFileSync } = await import("node:fs")
// 原生/运行时模块（node-pty、jiti）从 exe 旁的 node_modules 按绝对路径加载；
// 旁边没有（安装目录里只有 zip）时退回 Tauri 壳解压到应用数据目录的位置
const execDir = dirname(process.execPath)
const launchDir = process.cwd()
const localBaseDir = [execDir, launchDir].find(dir => existsSync(join(dir, "runtime", "current.json")))
if (!process.env.PIUI_RUNTIME_DIR && localBaseDir) {
  process.env.PIUI_RUNTIME_DIR = join(localBaseDir, "runtime")
}
if (!process.env.PIUI_NATIVE_MODULES) {
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

if (!process.env.PIUI_WORKER_BIN) {
  const runtimeDir = process.env.PIUI_RUNTIME_DIR
    ?? (localBaseDir ? join(localBaseDir, "runtime") : undefined)
  if (runtimeDir) {
    try {
      const pointer = JSON.parse(readFileSync(join(runtimeDir, "current.json"), "utf8")) as { dir?: unknown }
      if (typeof pointer.dir === "string" && pointer.dir && !pointer.dir.includes("..")) {
        const workerName = process.platform === "win32" ? "pi-worker.exe" : "pi-worker"
        const workerPath = join(runtimeDir, pointer.dir, workerName)
        if (existsSync(workerPath)) {
          process.env.PIUI_WORKER_BIN = workerPath
          const externalSdkRequested = Boolean(
            process.env.PIUI_SDK_PATH?.trim() || process.env.PIUI_USE_SYSTEM_PI === "1",
          )
          if (!externalSdkRequested) process.env.PIUI_BUNDLED_SDK = "1"
        }
      }
    } catch {
      // Development mode without a packaged worker falls back to self-spawn.
    }
  }
}

if (process.argv.includes("--pi-worker")) {
  await import("@piui/pi-worker/entry")
} else {
  // 编译形态没有独立 node 可 fork，worker 统一走自启动
  process.env.PIUI_WORKER_SELF = "1"
  // 打包分发的是正式产物，默认接真实 pi 驱动（开发态的 mock 默认值只留给仓库内运行）
  process.env.PIUI_DRIVER ??= "pi"
  await import("./index.ts")
}
