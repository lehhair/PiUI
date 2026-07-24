/**
 * Cross-platform: start server with PIUI_DRIVER=pi
 * Windows cmd cannot parse `PIUI_DRIVER=pi npm run ...`
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const env = { ...process.env, PIUI_DRIVER: "pi" }

const child = spawn("npm", ["run", "dev", "-w", "@piui/server"], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true,
})

child.on("exit", code => {
  process.exit(code ?? 0)
})
