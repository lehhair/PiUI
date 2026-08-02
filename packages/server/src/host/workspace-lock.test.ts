import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { acquireWorkspaceMutationLock } from "./workspace-lock.ts"

test("workspace mutation lock coordinates independent Node processes", async () => {
  const namespace = mkdtempSync(path.join(tmpdir(), "piui-workspace-lock-"))
  const workspace = mkdtempSync(path.join(tmpdir(), "piui-workspace-root-"))
  const childScript = [
    'import { acquireWorkspaceMutationLock } from "./src/host/workspace-lock.ts"',
    'const lock = await acquireWorkspaceMutationLock(process.env.PIUI_TEST_ROOT, { namespace: process.env.PIUI_TEST_NAMESPACE })',
    'process.stdout.write("ready\\n")',
    'await new Promise(resolve => setTimeout(resolve, 400))',
    'lock.release()',
  ].join(";")
  const child = spawn(process.execPath, ["--import", "tsx", "-e", childScript], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    env: { ...process.env, PIUI_TEST_ROOT: workspace, PIUI_TEST_NAMESPACE: namespace },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", chunk => { output += chunk })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not acquire lock: ${output}`)), 5_000)
      child.stdout.on("data", () => {
        if (!output.includes("ready")) return
        clearTimeout(timer)
        resolve()
      })
      child.once("error", reject)
      child.once("exit", code => {
        if (code !== 0) reject(new Error(`child exited before lock handoff: ${code}`))
      })
    })
    await assert.rejects(
      acquireWorkspaceMutationLock(workspace, { namespace, timeoutMs: 100 }),
      { code: "WORKSPACE_BUSY" },
    )
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`child exited with ${code}`)))
    })
    const lock = await acquireWorkspaceMutationLock(workspace, { namespace, timeoutMs: 500 })
    lock.release()
  } finally {
    child.kill()
    rmSync(namespace, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
