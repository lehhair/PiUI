import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { resolvePiSdkPath, shouldRequireVerifiedSdk } from "./sdk-host.ts"

test("external SDK verification is advisory unless explicitly enabled", () => {
  assert.equal(shouldRequireVerifiedSdk({}), false)
  assert.equal(shouldRequireVerifiedSdk({ PIUI_SDK_STRICT: "1" }), true)
  assert.equal(shouldRequireVerifiedSdk({ PIUI_SDK_STRICT: "0" }), false)
})

const globalRoot = join("C:\\npm-global")
const globalSdk = join(globalRoot, "@earendil-works", "pi-coding-agent")

function resolve(env: NodeJS.ProcessEnv, paths: string[] = []) {
  const existing = new Set(paths.map(path => path.replace(/\//g, "\\")))
  return resolvePiSdkPath({
    env,
    exists: path => existing.has(path.replace(/\//g, "\\")),
    npmRootGlobal: () => globalRoot,
  })
}

test("explicit PIUI_SDK_PATH selects an external SDK", () => {
  assert.deepEqual(resolve({ PIUI_SDK_PATH: "D:\\custom-pi" }), {
    sdkPath: "D:\\custom-pi",
    source: "env",
  })
})

test("system Pi is used only when explicitly requested", () => {
  const entry = join(globalSdk, "dist", "index.js")
  assert.deepEqual(resolve({ PIUI_USE_SYSTEM_PI: "1" }, [entry]), {
    sdkPath: globalSdk,
    source: "global",
  })
  assert.deepEqual(resolve({}, [entry]), { source: "bundled" })
})

test("an explicitly requested system Pi must be installed", () => {
  assert.throws(() => resolve({ PIUI_USE_SYSTEM_PI: "1" }), /not installed globally/)
})
