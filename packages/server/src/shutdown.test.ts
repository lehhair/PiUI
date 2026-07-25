import assert from "node:assert/strict"
import { createConnection } from "node:net"
import { it } from "node:test"
import { createAppServer } from "./http.ts"
import { shutdownAppServer } from "./shutdown.ts"
import { attachEventWebSocket } from "./ws.ts"

it("ends a stalled HTTP request at the shutdown deadline without forcing exit", async () => {
  const server = createAppServer()
  const eventServer = attachEventWebSocket(server)
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => (error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port")
  const socket = createConnection({ host: "127.0.0.1", port: address.port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  socket.write("POST /api/v1/workspaces HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{")

  let timedOut = false
  let forcedExit = false
  await shutdownAppServer(server, eventServer, {
    timeoutMs: 20,
    hardStopGraceMs: 20,
    onTimeout: () => { timedOut = true },
    forceExit: () => { forcedExit = true },
  })
  await new Promise(resolve => setTimeout(resolve, 30))

  assert.equal(timedOut, true)
  assert.equal(forcedExit, false)
  assert.equal(socket.destroyed, true)
})
