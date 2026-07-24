import { createRequire } from "node:module";
import { DEFAULT_HOST_HOST, DEFAULT_HOST_PORT } from "@piui/protocol";
import { PiuiHost } from "./host.js";
import { attachStdio } from "./stdio-transport.js";
import { startWsServer } from "./ws-server.js";

const require = createRequire(import.meta.url);

function readPiVersion(): string {
  try {
    const pkg = require("@earendil-works/pi-coding-agent/package.json") as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function parseArgs(argv: string[]) {
  let mode: "ws" | "stdio" = "ws";
  let host = DEFAULT_HOST_HOST;
  let port = DEFAULT_HOST_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdio") mode = "stdio";
    else if (a === "--ws") mode = "ws";
    else if (a === "--host" && argv[i + 1]) host = argv[++i]!;
    else if (a === "--port" && argv[i + 1]) port = Number(argv[++i]);
  }
  return { mode, host, port };
}

const { mode, host: bindHost, port } = parseArgs(process.argv.slice(2));
const host = new PiuiHost();
await host.start(readPiVersion());

if (mode === "stdio") {
  attachStdio(host);
  console.error(`[piui-host] stdio mode ready`);
} else {
  const server = await startWsServer(host, { host: bindHost, port });
  console.error(
    `[piui-host] ws://${server.host}:${server.port}  (dev only, local bind)`,
  );

  const shutdown = async () => {
    await server.close();
    await host.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
