import { createInterface } from "node:readline";
import type { HostCommand, HostEvent, WireMessage } from "@piui/protocol";
import type { PiuiHost } from "./host.js";

/**
 * JSONL over stdin/stdout — same framing as WS.
 * request: { channel:"request", id, cmd }
 * legacy: bare HostCommand (id optional)
 */
export function attachStdio(host: PiuiHost): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let seq = 0;

  host.onEvent((event: HostEvent) => {
    writeLine({ channel: "event", event } satisfies WireMessage);
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        writeLine({
          channel: "response",
          id: "",
          response: { ok: false, error: "invalid json" },
        } satisfies WireMessage);
        return;
      }

      const obj = parsed as { channel?: string; id?: string; cmd?: HostCommand; type?: string };
      let id: string;
      let cmd: HostCommand;
      if (obj.channel === "request" && obj.cmd) {
        id = obj.id ?? `s${++seq}`;
        cmd = { ...obj.cmd, id };
      } else if (obj.type) {
        id = obj.id ?? `s${++seq}`;
        cmd = { ...(obj as HostCommand), id };
      } else {
        writeLine({
          channel: "response",
          id: "",
          response: { ok: false, error: "invalid request" },
        } satisfies WireMessage);
        return;
      }

      const response = await host.handle(cmd);
      writeLine({
        channel: "response",
        id,
        response: { ...response, id },
      } satisfies WireMessage);
    })();
  });

  rl.on("close", () => {
    void host.dispose().then(() => process.exit(0));
  });
}

function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
