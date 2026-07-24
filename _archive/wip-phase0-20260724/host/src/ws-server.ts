import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_HOST_HOST,
  DEFAULT_HOST_PORT,
  type WireMessage,
  type WireRequest,
} from "@piui/protocol";
import type { PiuiHost } from "./host.js";

export type WsServerOptions = {
  host?: string;
  port?: number;
};

export async function startWsServer(
  piHost: PiuiHost,
  options: WsServerOptions = {},
): Promise<{ host: string; port: number; close: () => Promise<void> }> {
  const bindHost = options.host ?? DEFAULT_HOST_HOST;
  const bindPort = options.port ?? DEFAULT_HOST_PORT;

  const httpServer = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });
  const sockets = new Set<WebSocket>();

  const unsub = piHost.onEvent((event) => {
    const msg: WireMessage = { channel: "event", event };
    const data = JSON.stringify(msg);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  });

  wss.on("connection", (ws) => {
    sockets.add(ws);
    // 新连接立刻推 ready（启动时的 emit 客户端可能还没连上）
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({
          channel: "event",
          event: piHost.readyEvent(),
        } satisfies WireMessage),
      );
    }
    ws.on("close", () => sockets.delete(ws));
    ws.on("message", (raw) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          ws.send(
            JSON.stringify({
              channel: "response",
              id: "",
              response: { ok: false, error: "invalid json" },
            }),
          );
          return;
        }

        const msg = parsed as WireRequest;
        if (msg?.channel !== "request" || !msg.id || !msg.cmd) {
          ws.send(
            JSON.stringify({
              channel: "response",
              id: typeof msg?.id === "string" ? msg.id : "",
              response: { ok: false, error: "invalid request frame" },
            }),
          );
          return;
        }

        const cmd = { ...msg.cmd, id: msg.id };
        const response = await piHost.handle(cmd);
        const out: WireMessage = {
          channel: "response",
          id: msg.id,
          response: { ...response, id: msg.id },
        };
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(out));
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(bindPort, bindHost, () => resolve());
  });

  return {
    host: bindHost,
    port: bindPort,
    close: async () => {
      unsub();
      for (const ws of sockets) ws.close();
      sockets.clear();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
