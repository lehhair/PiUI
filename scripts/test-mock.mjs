import { spawn } from "node:child_process"

const env = { ...process.env, PIUI_DRIVER: "mock" }
const npmCli = process.env.npm_execpath

if (!npmCli) {
  throw new Error("npm_execpath is required to run the workspace test suite")
}

const commands = [
  ["run", "test:phase0"],
  ["run", "test:phase3"],
  ["run", "test:mvp"],
  ["run", "test:usable"],
  ["run", "test", "-w", "@piui/protocol"],
  ["run", "test", "-w", "@piui/server"],
  ["run", "test", "-w", "@piui/pi-worker"],
  ["run", "test:run", "-w", "@piui/app"],
]

for (const args of commands) {
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    })
    child.on("exit", exitCode => resolve(exitCode ?? 1))
    child.on("error", () => resolve(1))
  })
  if (code !== 0) process.exit(code)
}
