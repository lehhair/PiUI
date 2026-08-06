import { startPiUiServer } from "./start.ts"

void startPiUiServer().catch(error => {
  console.error(`[piui-server] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
