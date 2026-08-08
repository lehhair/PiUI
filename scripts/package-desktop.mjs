#!/usr/bin/env node
/**
 * 打包桌面/便携形态：
 *   dist-desktop/pi-worker.exe     Bun 编译的统一 server/worker/CLI 文件
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
mkdirSync(outDir, { recursive: true })
rmSync(join(outDir, "runtime"), { recursive: true, force: true })
rmSync(join(outDir, "piui-server.exe"), { force: true })
rmSync(join(outDir, "piui-server"), { force: true })

// ---- 1. 读取 Pi SDK 版本并准备公开 CLI 资源 ----
const piPackageDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent")
const piPkg = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"))
console.info(`[package] preparing Pi CLI resources ${piPkg.version}`)
// 同步 bundled SDK 版本常量：worker 用它做 parity 校验（sdk.VERSION 在
// Bun 打包后会失真，见 sdk-host.ts 注释）。
const bundledVersionPath = join(repoRoot, "packages", "pi-worker", "src", "bundled-sdk-version.ts")
writeFileSync(
  bundledVersionPath,
  `// The desktop packager replaces this constant with the active SDK version.\nexport const BUNDLED_PI_SDK_VERSION = ${JSON.stringify(piPkg.version)}\n`,
)
cpSync(join(piPackageDir, "package.json"), join(outDir, "package.json"))
for (const [source, destination] of [
  [join(piPackageDir, "dist", "modes", "interactive", "theme"), join(outDir, "theme")],
  [join(piPackageDir, "dist", "modes", "interactive", "assets"), join(outDir, "assets")],
  [join(piPackageDir, "dist", "core", "export-html"), join(outDir, "export-html")],
  [join(piPackageDir, "README.md"), join(outDir, "README.md")],
  [join(piPackageDir, "CHANGELOG.md"), join(outDir, "CHANGELOG.md")],
  [join(piPackageDir, "docs"), join(outDir, "docs")],
  [join(piPackageDir, "examples"), join(outDir, "examples")],
]) {
  cpSync(source, destination, { recursive: true })
}
const photonWasm = join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm")
if (existsSync(photonWasm)) cpSync(photonWasm, join(outDir, "photon_rs_bg.wasm"))

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
const outfile = join(outDir, target.includes("windows") ? "pi-worker.exe" : "pi-worker")
run("bun", [
  "build", join("packages", "server", "dist", "bundle-entry.js"),
  "--compile",
  `--target=${target}`,
  "--external", "bun-pty",
  "--external", "@lydell/node-pty",
  ...(target.includes("windows") ? ["--icon", join("packages", "app", "assets", "build", "pi.ico")] : []),
  "--outfile", outfile,
])

const requiredFiles = [
  outfile,
  join(outDir, "web", "index.html"),
  join(outDir, "package.json"),
  join(outDir, "theme"),
  join(outDir, "export-html"),
  join(outDir, "node_modules", "bun-pty", "src", "index.ts"),
  join(outDir, "node_modules", "bun-pty", "rust-pty", "target", "release", nativeLibrary),
]
for (const file of requiredFiles) {
  if (!existsSync(file)) throw new Error(`desktop package is missing required resource: ${file}`)
}

console.info(`
[package] done → ${outDir}
  pi-worker    Web/API 服务、Pi worker 和原生 CLI
  web/         Web 客户端，server 同端口托管
局域网/手机访问：pi-worker.exe web --host 0.0.0.0
`)
