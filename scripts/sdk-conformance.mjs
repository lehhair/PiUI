// SDK 升级一致性门禁（R12 升级 conformance）
//
// 每次升级 @earendil-works/pi-coding-agent 后运行：
//   node scripts/sdk-conformance.mjs [--check-only]
//
// 流程：
//   1. 校验三处版本一致：protocol 的 PI_PARITY_SDK_VERSION、
//      pi-worker 的依赖声明、node_modules 实际安装版本
//   2. 重新构建 protocol + pi-worker（server 测试从 dist 拉起 worker）
//   3. 运行协议测试 + pi-worker 测试（含真实 SDK conformance 冒烟、
//      模块契约、会话契约、runtime 绑定门禁）
//   4. 提示刷新 docs/PI_UI_INTEGRATION.md 矩阵
//
// --check-only：只校验版本一致，不跑测试（用于快速门禁）

import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const checkOnly = process.argv.includes("--check-only")

function readVersionFile(file) {
  return readFileSync(join(root, file), "utf8")
}

// 1. 版本一致性 ------------------------------------------------

const protocolSource = readVersionFile("packages/protocol/src/version.ts")
const parityMatch = protocolSource.match(/PI_PARITY_SDK_VERSION = "([^"]+)"/)
if (!parityMatch) {
  throw new Error("PI_PARITY_SDK_VERSION not found in packages/protocol/src/version.ts")
}
const parityVersion = parityMatch[1]

const workerPackage = JSON.parse(readVersionFile("packages/pi-worker/package.json"))
const declaredVersion = workerPackage.dependencies?.["@earendil-works/pi-coding-agent"]
if (typeof declaredVersion !== "string") {
  throw new Error("@earendil-works/pi-coding-agent dependency missing in packages/pi-worker/package.json")
}

const installedPackage = JSON.parse(readVersionFile("node_modules/@earendil-works/pi-coding-agent/package.json"))
const installedVersion = installedPackage.version

const mismatches = []
if (parityVersion !== declaredVersion) {
  mismatches.push(`protocol PI_PARITY_SDK_VERSION=${parityVersion} != pi-worker dependency ${declaredVersion}`)
}
if (parityVersion !== installedVersion) {
  mismatches.push(`protocol PI_PARITY_SDK_VERSION=${parityVersion} != installed SDK ${installedVersion}`)
}

if (mismatches.length > 0) {
  console.error("SDK conformance FAILED — version drift:")
  for (const mismatch of mismatches) console.error(`  - ${mismatch}`)
  console.error(
    "\n升级流程：\n" +
    "  1. pnpm add @earendil-works/pi-coding-agent@<new> -w @piui/pi-worker\n" +
    "  2. 更新 packages/protocol/src/version.ts 的 PI_PARITY_SDK_VERSION 为同一版本\n" +
    "  3. 重新运行 node scripts/sdk-conformance.mjs\n" +
    "  4. 按 docs/PI_UI_INTEGRATION.md 底部完成门禁逐项核对矩阵",
  )
  process.exit(1)
}

console.log(`SDK conformance: version aligned @ ${parityVersion} (parity / declared / installed)`)
if (checkOnly) process.exit(0)

// 2-3. 构建 + 测试 ----------------------------------------------

// 工作区脚本在各自包目录里直接跑，避免 npm(-w) 与 pnpm(--filter/-w)
// 的 workspace 参数差异。
const steps = [
  { pkg: "packages/protocol", args: ["run", "build"] },
  { pkg: "packages/pi-worker", args: ["run", "build"] },
  { pkg: "packages/protocol", args: ["run", "test"] },
  { pkg: "packages/pi-worker", args: ["run", "test"] },
]

const npmCli = process.env.npm_execpath
if (!npmCli) {
  throw new Error("npm_execpath is required to run the workspace test suite")
}

for (const { pkg, args } of steps) {
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: join(root, pkg),
      env: { ...process.env, PIUI_DRIVER: "mock" },
      stdio: "inherit",
    })
    child.on("exit", exitCode => resolve(exitCode ?? 1))
    child.on("error", () => resolve(1))
  })
  if (code !== 0) process.exit(code)
}

// 4. 矩阵刷新提醒 ----------------------------------------------

console.log(
  "\nSDK conformance PASSED. 升级后请按 docs/PI_UI_INTEGRATION.md 完成门禁：\n" +
  "  - 重跑 API diff（新增/改名/删除的 Pi 导出是否影响契约清单）\n" +
  "  - fixture replay 与完整测试矩阵\n" +
  "  - 更新矩阵中的版本基线",
)
