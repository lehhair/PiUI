import type { Server as HttpServer } from "node:http"
import type { WebSocketServer } from "ws"
import { closeEventWebSocket } from "./ws.ts"

export interface ShutdownOptions {
  timeoutMs?: number
  hardStopGraceMs?: number
  forceExit?: (code: number) => void
  onTimeout?: () => void
  cleanup?: () => Promise<void>
}

export function shutdownAppServer(
  server: HttpServer,
  eventServer: WebSocketServer,
  options: ShutdownOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const hardStopGraceMs = options.hardStopGraceMs ?? 1_000
  const forceExit = options.forceExit ?? (code => process.exit(code))
  let hardStop: NodeJS.Timeout | undefined
  const deadline = setTimeout(() => {
    options.onTimeout?.()
    server.closeAllConnections()
    hardStop = setTimeout(() => forceExit(1), hardStopGraceMs)
    hardStop.unref()
  }, timeoutMs)
  deadline.unref()

  const closing = Promise.allSettled([
    new Promise<void>((resolve, reject) => {
      closeEventWebSocket(eventServer, error => (error ? reject(error) : resolve()))
    }),
    new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  ]).then(async results => {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failure) throw failure.reason
    await options.cleanup?.()
  })

  void closing.finally(() => {
    clearTimeout(deadline)
    if (hardStop) clearTimeout(hardStop)
  }).catch(() => undefined)
  return closing
}
