#!/usr/bin/env node

/**
 * prepare-release.mjs - Validate before version bumping
 *
 * Usage:
 *   node scripts/prepare-release.mjs <version>
 *   node scripts/prepare-release.mjs <version> --skip-validate
 *
 * What it does:
 *   1. Ensures the git worktree is clean before starting
 *   2. Runs `npm run validate` by default
 *   3. Runs bump-version.mjs to update release files
 *   4. Prints the remaining git steps (commit, tag, push)
 */

import { execSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const args = process.argv.slice(2)
const showHelp = args.includes('--help') || args.includes('-h')
const skipValidate = args.includes('--skip-validate')
const version = args.find(arg => !arg.startsWith('-'))

if (showHelp || !version) {
  console.log('Usage: node scripts/prepare-release.mjs <version> [--skip-validate]')
  console.log('  e.g. node scripts/prepare-release.mjs 0.2.0')
  console.log('  e.g. node scripts/prepare-release.mjs 0.2.1-canary.1')
  process.exit(showHelp ? 0 : 1)
}

const tagName = `v${version}`

function run(command, label) {
  console.log(`\n> ${label}`)
  execSync(command, { cwd: root, stdio: 'inherit' })
}

function read(command) {
  return execSync(command, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

const worktreeStatus = read('git status --short')
if (worktreeStatus) {
  console.error('Release preparation requires a clean git worktree.')
  console.error('Please commit, stash, or discard local changes first.')
  process.exit(1)
}

try {
  const localTag = read(`git tag -l ${tagName}`)
  if (localTag === tagName) {
    console.error(`Tag ${tagName} already exists locally.`)
    process.exit(1)
  }
} catch {
  // Ignore local tag lookup failures and continue.
}

try {
  const remoteTag = read(`git ls-remote --tags origin refs/tags/${tagName}`)
  if (remoteTag) {
    console.error(`Tag ${tagName} already exists on origin.`)
    process.exit(1)
  }
} catch {
  // If origin is unavailable, let later git commands surface the real error.
}

if (!skipValidate) {
  run('npm run validate', 'Running release validation')
} else {
  console.log('\n> Skipping release validation (--skip-validate)')
}

run(`node scripts/bump-version.mjs ${version}`, `Preparing release ${tagName}`)

console.log(`
Release preparation finished for ${tagName}.

Next steps:
  git add -A
  git commit -m "chore: bump version to ${version}"
  git tag ${tagName}
  git push && git push origin ${tagName}
`)
