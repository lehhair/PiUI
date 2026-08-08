import { spawn } from "node:child_process"

const env = { ...process.env, PIUI_DRIVER: "mock" }
const npmCli = process.env.npm_execpath

if (!npmCli) {
  throw new Error("npm_execpath is required to run the workspace test suite")
}

// CI 上 worker spawn 偶发挂起会拖死整个 validate；每个子命令设硬超时，
// 超时 kill 并明确报出卡住的命令，避免 job 挂到 runner 上限。
const COMMAND_TIMEOUT_MS = Number(process.env.PIUI_TEST_COMMAND_TIMEOUT_MS) || 300_000

const commands = [
  ["run", "build", "-w", "@piui/protocol"],
  ["run", "build", "-w", "@piui/pi-worker"],
  ["run", "build", "-w", "@piui/server"],
  ["run", "test", "-w", "@piui/protocol"],
  ["run", "test", "-w", "@piui/pi-worker"],
  ["run", "test", "-w", "@piui/server"],
  ["run", "test:run", "-w", "@piui/app"],
]

for (const args of commands) {
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    })
    const timer = setTimeout(() => {
      console.error(`\n[test-mock] ${args.join(" ")} exceeded ${COMMAND_TIMEOUT_MS}ms; killing the command`)
      child.kill("SIGKILL")
    }, COMMAND_TIMEOUT_MS)
    child.on("exit", exitCode => {
      clearTimeout(timer)
      resolve(exitCode ?? 1)
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve(1)
    })
  })
  if (code !== 0) process.exit(code)
}
