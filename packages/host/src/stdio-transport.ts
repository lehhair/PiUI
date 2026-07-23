import { createInterface } from "node:readline";
import type { HostCommand, HostEvent, HostResponse } from "@piui/protocol";
import type { PiuiHost } from "./host.js";

/**
 * JSONL over stdin/stdout for local dev / later IPC bridge.
 * One command line in → one response line out; events are async lines with type "event".
 */
export function attachStdio(host: PiuiHost): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  host.onEvent((event: HostEvent) => {
    writeLine({ channel: "event", event });
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      let cmd: HostCommand;
      try {
        cmd = JSON.parse(trimmed) as HostCommand;
      } catch {
        writeLine({ channel: "response", response: { ok: false, error: "invalid json" } });
        return;
      }
      const response: HostResponse = await host.handle(cmd);
      writeLine({ channel: "response", response });
    })();
  });

  rl.on("close", () => {
    void host.dispose().then(() => process.exit(0));
  });
}

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
