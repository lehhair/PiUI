#!/usr/bin/env node

/**
 * update-pi-sdk.mjs — 一键升级内置 Pi SDK 版本（及整族 @earendil-works 依赖）
 *
 * Usage:
 *   node scripts/update-pi-sdk.mjs                 # 自动取 npm 最新版
 *   node scripts/update-pi-sdk.mjs 0.84.1          # 指定版本
 *   node scripts/update-pi-sdk.mjs 0.85.0 --no-install
 *
 * 更新范围：
 *   1. 各 package.json 里所有 @earendil-works 依赖（保留 ^ 前缀风格）
 *   2. packages/protocol/src/version.ts  的 PI_PARITY_SDK_VERSION
 *   3. packages/pi-worker/src/bundled-sdk-version.ts 的 BUNDLED_PI_SDK_VERSION
 *   4. packages/protocol/src/index.test.ts 的 parity 断言
 *   5. docs/ 里标注的 SDK 基线版本
 *   6. 重新 npm install 更新 lockfile / node_modules
 *
 * 注意：Pi SDK 家族版本必须一致（sdk-host 的 sdkFamilyCompatible 校验），
 * 所以本脚本会把 pi-coding-agent / pi-ai / pi-agent-core / pi-tui 一起升。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 解析目标版本
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const explicit = args.find(a => /^\d+\.\d+\.\d+$/.test(a))
const noInstall = args.includes('--no-install')

let version = explicit
if (!version) {
  try {
    version = execSync('npm view @earendil-works/pi-coding-agent version', {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  } catch {
    console.error('无法从 npm 获取最新版本，请显式传入：node scripts/update-pi-sdk.mjs <version>')
    process.exit(1)
  }
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`无效版本号: "${version}"（需要 MAJOR.MINOR.PATCH）`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. package.json 里的 @earendil-works 依赖
// ---------------------------------------------------------------------------
const packageFiles = ['packages/app/package.json', 'packages/pi-worker/package.json']
const changed = []

for (const rel of packageFiles) {
  const file = join(repoRoot, rel)
  if (!existsSync(file)) continue
  const json = JSON.parse(readFileSync(file, 'utf8'))
  let touched = false
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = json[section]
    if (!deps) continue
    for (const key of Object.keys(deps)) {
      if (!key.startsWith('@earendil-works/')) continue
      const current = deps[key]
      const match = /^(\^)?\d+\.\d+\.\d+/.exec(current)
      if (!match) {
        console.warn(`  ⚠ ${rel}: ${key}="${current}" 不是纯 semver，跳过`)
        continue
      }
      const next = `${match[1] ?? ''}${version}`
      if (next !== current) {
        deps[key] = next
        touched = true
        console.log(`  ${rel}: ${key} ${current} -> ${next}`)
      }
    }
  }
  if (touched) {
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    changed.push(rel)
  }
}

// ---------------------------------------------------------------------------
// 2~4. 源码常量与测试断言
// ---------------------------------------------------------------------------
function patchText(rel, pattern, replacement) {
  const file = join(repoRoot, rel)
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  const next = text.replace(pattern, replacement)
  if (next !== text) {
    writeFileSync(file, next, 'utf8')
    changed.push(rel)
    console.log(`  ${rel} 已更新`)
  }
}

patchText('packages/protocol/src/version.ts', /(PI_PARITY_SDK_VERSION = ")\d+\.\d+\.\d+(")/, `$1${version}$2`)
patchText('packages/pi-worker/src/bundled-sdk-version.ts', /(BUNDLED_PI_SDK_VERSION = ")\d+\.\d+\.\d+(")/, `$1${version}$2`)
patchText('packages/protocol/src/index.test.ts', /(PI_PARITY_SDK_VERSION, ")\d+\.\d+\.\d+(")/, `$1${version}$2`)

// ---------------------------------------------------------------------------
// 5. 文档基线
// ---------------------------------------------------------------------------
for (const rel of ['docs/PIUI_MASTER_PLAN.md', 'docs/PI_UI_INTEGRATION.md']) {
  const file = join(repoRoot, rel)
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/@earendil-works\/pi-coding-agent@\d+\.\d+\.\d+/g, `@earendil-works/pi-coding-agent@${version}`)
    .replace(/# Pi \d+\.\d+\.\d+ Native Parity Matrix/, `# Pi ${version} Native Parity Matrix`)
    .replace(/基线固定为 `@earendil-works\/pi-coding-agent@\d+\.\d+\.\d+`/, `基线固定为 \`@earendil-works/pi-coding-agent@${version}\``)
  if (next !== text) {
    writeFileSync(file, next, 'utf8')
    changed.push(rel)
    console.log(`  ${rel} 已更新`)
  }
}

// ---------------------------------------------------------------------------
// 6. npm install
// ---------------------------------------------------------------------------
if (noInstall) {
  console.log(`\n[update-pi-sdk] 已更新文件（跳过 npm install）：\n  - ${changed.join('\n  - ')}`)
  console.log('\n下一步：npm install && npm run build && npm test')
  process.exit(0)
}

console.log(`\n[update-pi-sdk] 执行 npm install 更新 lockfile / node_modules ...`)
try {
  execSync('npm install --no-audit --no-fund', { cwd: repoRoot, stdio: 'inherit' })
} catch (error) {
  console.error('\n[update-pi-sdk] npm install 失败，请检查版本兼容性')
  process.exit(1)
}

console.log(`\n[update-pi-sdk] Pi SDK 已升级到 ${version}`)
console.log('已更新：')
console.log(`  - ${changed.join('\n  - ')}`)
console.log('\n下一步（建议顺序）：')
console.log('  1. npm run build   （protocol → pi-worker → server → app）')
console.log('  2. npm test        （协议/worker/server/app 全量测试，验证 parity）')
console.log('  3. 发版时：node packages/app/scripts/bump-version.mjs <新版本>')
