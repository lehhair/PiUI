import assert from "node:assert/strict"
import test from "node:test"
import { dirname, join } from "node:path"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolvePiSdkPath, shouldRequireVerifiedSdk } from "./sdk-host.ts"

test("external SDK verification is strict unless explicitly disabled", () => {
  assert.equal(shouldRequireVerifiedSdk({}), true)
  assert.equal(shouldRequireVerifiedSdk({ PIUI_SDK_STRICT: "1" }), true)
  assert.equal(shouldRequireVerifiedSdk({ PIUI_SDK_STRICT: "0" }), false)
})

function fakeFs(paths: string[]) {
  const set = new Set(paths.map(path => path.replace(/\//g, "\\")))
  return (path: string) => set.has(path.replace(/\//g, "\\"))
}

const GLOBAL_ROOT = join("C:\\npm-global")
const GLOBAL_SDK = join(GLOBAL_ROOT, "@earendil-works", "pi-coding-agent")
const EXEC_DIR = join("C:\\PiUI")

function resolveDeps(overrides: Partial<Parameters<typeof resolvePiSdkPath>[0]> = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    execDir: EXEC_DIR,
    exists: fakeFs([]),
    npmRootGlobal: () => GLOBAL_ROOT,
    ...overrides,
  }
}

test("explicit PIUI_SDK_PATH wins over every other source", () => {
  const result = resolvePiSdkPath(resolveDeps({
    env: { PIUI_SDK_PATH: "D:\\custom-pi" } as NodeJS.ProcessEnv,
    exists: fakeFs([join(GLOBAL_SDK, "dist", "index.js")]),
  }))
  assert.deepEqual(result, { sdkPath: "D:\\custom-pi", source: "env" })
})

test("user global npm install is preferred over the bundled runtime", () => {
  const result = resolvePiSdkPath(resolveDeps({
    exists: fakeFs([
      join(GLOBAL_SDK, "dist", "index.js"),
      join(EXEC_DIR, "runtime", "pi", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
    ]),
  }))
  assert.deepEqual(result, { sdkPath: GLOBAL_SDK, source: "global" })
})

test("legacy @mariozechner package name is accepted as a global install", () => {
  const legacy = join(GLOBAL_ROOT, "@mariozechner", "pi-coding-agent")
  const result = resolvePiSdkPath(resolveDeps({
    exists: fakeFs([join(legacy, "dist", "index.js")]),
  }))
  assert.deepEqual(result, { sdkPath: legacy, source: "global" })
})

test("bundled runtime is used when no global install exists", () => {
  const sdk = join(EXEC_DIR, "runtime", "pi", "node_modules", "@earendil-works", "pi-coding-agent")
  const result = resolvePiSdkPath(resolveDeps({
    exists: fakeFs([join(sdk, "dist", "index.js")]),
  }))
  assert.deepEqual(result, { sdkPath: sdk, source: "runtime" })
})

test("updater pointer current.json selects the hot-updated runtime copy", () => {
  const root = mkdtempSync(join(tmpdir(), "piui-sdk-"))
  try {
    const execDir = join(root, "app")
    const runtimeDir = join(execDir, "runtime")
    const updated = join(runtimeDir, "pi-0.82.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist")
    mkdirSync(updated, { recursive: true })
    writeFileSync(join(updated, "index.js"), "export {}")
    writeFileSync(join(runtimeDir, "current.json"), JSON.stringify({ dir: "pi-0.82.0" }))
    const result = resolvePiSdkPath(resolveDeps({
      execDir,
      exists: existsSync,
      npmRootGlobal: () => undefined,
    }))
    assert.deepEqual(result, { sdkPath: dirname(updated), source: "runtime" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing runtime pointer and directories fall back to the bundled SDK", () => {
  const result = resolvePiSdkPath(resolveDeps({ npmRootGlobal: () => undefined }))
  assert.deepEqual(result, { source: "bundled" })
})
