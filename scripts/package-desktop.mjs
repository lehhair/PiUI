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

// ---- 1. 组装 runtime/pi：从仓库 node_modules 复制 pi 的依赖闭包 ----
const piPackageDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent")
const piPkg = JSON.parse(readFileSync(join(piPackageDir, "package.json"), "utf8"))
if (skipRuntime && existsSync(join(outDir, "runtime", "current.json"))) {
  console.info("[package] --skip-runtime: keeping existing runtime directory")
} else {
  const runtimePi = join(outDir, "runtime", "pi", "node_modules")
  rmSync(join(outDir, "runtime"), { recursive: true, force: true })
  mkdirSync(runtimePi, { recursive: true })

  // pi 的完整闭包恰好嵌套在它自己的 node_modules 里（npm workspaces 的
  // 安装形态），把它和包本体一起整树复制即可，无需重新解析依赖
  console.info(`[package] copying pi ${piPkg.version} runtime closure (this is ~150MB)`)
  cpSync(piPackageDir, join(runtimePi, "@earendil-works", "pi-coding-agent"), { recursive: true })
  writeFileSync(
    join(outDir, "runtime", "current.json"),
    JSON.stringify({ dir: "pi", version: piPkg.version }, null, 2),
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
