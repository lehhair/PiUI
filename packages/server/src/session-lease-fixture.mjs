import { SessionLeaseManager } from "./session-lease.ts"

const [namespace, sessionFile] = process.argv.slice(2)
const manager = new SessionLeaseManager(namespace)
let lease

process.on("message", async message => {
  if (message === "acquire") {
    try {
      lease = await manager.acquire(sessionFile)
      process.send?.("acquired")
    } catch (error) {
      process.send?.(error?.code === "SESSION_BUSY" ? "busy" : `error:${error}`)
    }
    return
  }
  if (message === "release") {
    lease?.release()
    lease = undefined
    process.send?.("released")
    return
  }
  if (message === "shutdown") {
    manager.dispose()
    process.disconnect()
  }
})
