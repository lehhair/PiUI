#!/usr/bin/env node
/**
 * 打包桌面/便携形态：
 *   dist-desktop/piui-server.exe   bun compile 的单文件（server + worker 双模式）
 *   dist-desktop/runtime/pi/…      外挂 pi SDK（node_modules 布局，可热更新）
 *   dist-desktop/web/…             Web 客户端构建产物
 *
 * 用法：node scripts/package-desktop.mjs [--skip-build] [--target bun-windows-x64]
 */
import { execFileSync, execSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(repoRoot, "dist-desktop")
const args = process.argv.slice(2)
const skipBuild = args.includes("--skip-build")
const skipRuntime = args.includes("--skip-runtime")
const target = args.find((arg, i) => args[i - 1] === "--target") ?? "bun-windows-x64"

const run = (command, cmdArgs, options = {}) => {
  console.info(`$ ${command} ${cmdArgs.join(" ")}`)
  execFileSync(command, cmdArgs, { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32", ...options })
}

if (!skipBuild) {
  run("npm", ["run", "build"])
}

// ---- 1. 组装独立的、可切换的 Pi SDK runtime ----
const piPackageDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent")
const piPkg = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"))
const sdkFamily = {
  "@earendil-works/pi-coding-agent": piPkg.version,
  "@earendil-works/pi-ai": piPkg.version,
  "@earendil-works/pi-agent-core": piPkg.version,
  "@earendil-works/pi-tui": piPkg.version,
}

if (skipRuntime && existsSync(join(outDir, "runtime", "current.json"))) {
  console.info("[package] --skip-runtime: keeping existing runtime directory")
} else {
  const runtimePiRoot = join(outDir, "runtime", `pi-${piPkg.version}`)
  const runtimePi = join(runtimePiRoot, "node_modules")
  rmSync(join(outDir, "runtime"), { recursive: true, force: true })
  mkdirSync(runtimePi, { recursive: true })

  // Let npm construct the actual dependency tree. The SDK is loaded from disk
  // through jiti, so its direct dependencies must live under their owning
  // package rather than relying on workspace hoisting.
  console.info(`[package] installing pi ${piPkg.version} runtime dependencies`)
  writeFileSync(join(runtimePiRoot, "package.json"), JSON.stringify({
    name: "piui-bundled-runtime",
    private: true,
    dependencies: sdkFamily,
    overrides: sdkFamily,
  }, null, 2))
  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install",
    "--prefix", runtimePiRoot,
    "--legacy-bundling",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `@earendil-works/pi-coding-agent@${piPkg.version}`,
  ])
  const sdkScopedRoot = join(
    runtimePi,
    "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works",
  )
  for (const packageName of readdirSync(sdkScopedRoot)) {
    const packageDir = join(sdkScopedRoot, packageName)
    if (!existsSync(join(packageDir, "package.json"))) continue
    console.info(`[package] nesting dependencies for @earendil-works/${packageName}`)
    const nestedPackageJsonPath = join(packageDir, "package.json")
    const nestedPackageJson = JSON.parse(readFileSync(nestedPackageJsonPath, "utf8"))
    nestedPackageJson.overrides = sdkFamily
    writeFileSync(nestedPackageJsonPath, JSON.stringify(nestedPackageJson, null, 2))
    run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "install",
      "--prefix", packageDir,
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
    ])
  }
  const sdkEntry = join(runtimePi, "@earendil-works", "pi-coding-agent", "dist", "index.js")
  const partialJson = join(
    runtimePi,
    "@earendil-works", "pi-coding-agent", "node_modules",
    "@earendil-works", "pi-ai", "node_modules", "partial-json", "package.json",
  )
  if (!existsSync(sdkEntry) || !existsSync(partialJson)) {
    throw new Error("npm did not create a complete Pi SDK runtime dependency tree")
  }
  writeFileSync(
    join(outDir, "runtime", "current.json"),
    JSON.stringify({ dir: `pi-${piPkg.version}`, version: piPkg.version, sdkFamily }, null, 2),
  )
}

// ---- 2. Web 客户端 ----
console.info("[package] copying web client")
rmSync(join(outDir, "web"), { recursive: true, force: true })
cpSync(join(repoRoot, "packages", "app", "dist"), join(outDir, "web"), { recursive: true })

// ---- 2.5 原生/运行时依赖外挂：node-pty 的平台二进制无法打进 bundle；
// jiti 内部相对引用自己的 babel.cjs，进 bundle 路径就断——都放 exe 旁的
// node_modules，构建期声明 external 的运行时模块从这里解析 ----
console.info("[package] copying native node-pty packages")
const nativeOut = join(outDir, "node_modules")
rmSync(nativeOut, { recursive: true, force: true })
mkdirSync(nativeOut, { recursive: true })
const lydellDir = join(repoRoot, "node_modules", "@lydell")
const lydellPackages = existsSync(lydellDir) ? readdirSync(lydellDir) : []
const externalPackages = ["jiti"]
for (const name of lydellPackages) {
  cpSync(join(lydellDir, name), join(nativeOut, "@lydell", name), { recursive: true })
  externalPackages.push(`@lydell/${name}`)
}
cpSync(join(repoRoot, "node_modules", "jiti"), join(nativeOut, "jiti"), { recursive: true })

// ---- 3. bun compile ----
// pi SDK 只是运行时动态 import 的外部路径，不进 bundle；node-pty 原生包
// 同样 external，从上一步的 node_modules 加载
const outfile = join(outDir, target.includes("windows") ? "piui-server.exe" : "piui-server")
run("bun", [
  "build", join("packages", "server", "dist", "bundle-entry.js"),
  "--compile",
  `--target=${target}`,
  "--external", "@earendil-works/*",
  "--external", "@mariozechner/*",
  ...externalPackages.flatMap(name => ["--external", name]),
  ...(target.includes("windows") ? ["--icon", join("packages", "app", "assets", "build", "pi.ico")] : []),
  "--outfile", outfile,
])

console.info(`
[package] done → ${outDir}
  piui-server  可执行文件（PIUI_WORKER_SELF 已内置双模式）
  runtime/     pi SDK ${piPkg.version}（启动顺序：用户全局 pi > 此目录）
  web/         Web 客户端，server 同端口托管
局域网/手机访问：PIUI_HOST=0.0.0.0 启动后，用控制台打印的带 token 链接打开
`)
