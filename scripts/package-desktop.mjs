#!/usr/bin/env node
/**
 * 打包桌面/便携形态：
 *   dist-desktop/piui-server.exe   Bun 编译的 server 单文件
 *   dist-desktop/runtime/pi-…/     自包含 Pi worker
 *   dist-desktop/web/…             Web 客户端构建产物
 *
 * 用法：node scripts/package-desktop.mjs [--skip-build] [--target bun-windows-x64]
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(repoRoot, "dist-desktop")
const args = process.argv.slice(2)
const skipBuild = args.includes("--skip-build")
const target = args.find((arg, i) => args[i - 1] === "--target") ?? "bun-windows-x64"

const run = (command, cmdArgs, options = {}) => {
  console.info(`$ ${command} ${cmdArgs.join(" ")}`)
  execFileSync(command, cmdArgs, { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32", ...options })
}

if (!skipBuild) {
  run("npm", ["run", "build"])
}

// ---- 1. 组装独立的 Pi worker runtime ----
const piPackageDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent")
const piPkg = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"))
const sdkFamily = {
  "@earendil-works/pi-coding-agent": piPkg.version,
  "@earendil-works/pi-ai": piPkg.version,
  "@earendil-works/pi-agent-core": piPkg.version,
  "@earendil-works/pi-tui": piPkg.version,
}

const runtimePiRoot = join(outDir, "runtime", `pi-${piPkg.version}`)
rmSync(join(outDir, "runtime"), { recursive: true, force: true })
mkdirSync(runtimePiRoot, { recursive: true })

console.info(`[package] compiling self-contained pi worker ${piPkg.version}`)
writeFileSync(
  join(repoRoot, "packages", "pi-worker", "dist", "bundled-sdk-version.js"),
  `export const BUNDLED_PI_SDK_VERSION = ${JSON.stringify(piPkg.version)};\n`,
)
const workerName = target.includes("windows") ? "pi-worker.exe" : "pi-worker"
run("bun", [
  "build", join("packages", "pi-worker", "dist", "entry.js"),
  "--compile",
  `--target=${target}`,
  "--outfile", join(runtimePiRoot, workerName),
])
writeFileSync(join(runtimePiRoot, "manifest.json"), JSON.stringify({
  sdkVersion: piPkg.version,
  worker: workerName,
  sdkFamily,
}, null, 2))
writeFileSync(
  join(outDir, "runtime", "current.json"),
  JSON.stringify({ dir: `pi-${piPkg.version}`, version: piPkg.version, sdkFamily }, null, 2),
)

// ---- 2. Web 客户端 ----
console.info("[package] copying web client")
rmSync(join(outDir, "web"), { recursive: true, force: true })
cpSync(join(repoRoot, "packages", "app", "dist"), join(outDir, "web"), { recursive: true })

// ---- 2.5 Bun PTY 原生库 ----
console.info("[package] copying bun-pty")
const nativeOut = join(outDir, "node_modules")
rmSync(nativeOut, { recursive: true, force: true })
mkdirSync(nativeOut, { recursive: true })
const bunPtyDir = join(repoRoot, "node_modules", "bun-pty")
if (!existsSync(bunPtyDir)) throw new Error("bun-pty is not installed")
const bunPtyOut = join(nativeOut, "bun-pty")
mkdirSync(join(bunPtyOut, "src"), { recursive: true })
mkdirSync(join(bunPtyOut, "rust-pty", "target", "release"), { recursive: true })
cpSync(join(bunPtyDir, "package.json"), join(bunPtyOut, "package.json"))
cpSync(join(bunPtyDir, "LICENSE"), join(bunPtyOut, "LICENSE"))
for (const file of ["index.ts", "interfaces.ts", "terminal.ts"]) {
  cpSync(join(bunPtyDir, "src", file), join(bunPtyOut, "src", file))
}
const nativeLibrary = target.includes("windows")
  ? "rust_pty.dll"
  : target.includes("darwin")
    ? (target.includes("arm64") ? "librust_pty_arm64.dylib" : "librust_pty.dylib")
    : (target.includes("arm64") ? "librust_pty_arm64.so" : "librust_pty.so")
const nativeLibraryPath = join(bunPtyDir, "rust-pty", "target", "release", nativeLibrary)
if (!existsSync(nativeLibraryPath)) throw new Error(`bun-pty native library is missing: ${nativeLibraryPath}`)
cpSync(nativeLibraryPath, join(bunPtyOut, "rust-pty", "target", "release", nativeLibrary))

// ---- 3. bun compile ----
const outfile = join(outDir, target.includes("windows") ? "piui-server.exe" : "piui-server")
run("bun", [
  "build", join("packages", "server", "dist", "bundle-entry.js"),
  "--compile",
  `--target=${target}`,
  "--external", "bun-pty",
  "--external", "@lydell/node-pty",
  ...(target.includes("windows") ? ["--icon", join("packages", "app", "assets", "build", "pi.ico")] : []),
  "--outfile", outfile,
])

console.info(`
[package] done → ${outDir}
  piui-server  服务端可执行文件
  runtime/     自包含 Pi worker ${piPkg.version}
  web/         Web 客户端，server 同端口托管
局域网/手机访问：PIUI_HOST=0.0.0.0 启动后，用控制台打印的带 token 链接打开
`)
