import {
  DEFAULT_HOST_WS_URL,
  type HostCommand,
  type HostEvent,
  type HostResponse,
  type WireMessage,
} from "@piui/protocol";

type Listener = (event: HostEvent) => void;

export class WsHostTransport {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<
    string,
    { resolve: (r: HostResponse) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private status: "idle" | "connecting" | "open" | "closed" = "idle";
  private statusListeners = new Set<(s: typeof this.status) => void>();

  constructor(private readonly url: string = DEFAULT_HOST_WS_URL) {}

  getStatus() {
    return this.status;
  }

  onStatus(listener: (s: typeof this.status) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: typeof this.status) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent) {
    for (const l of this.listeners) l(event);
  }

  async connect(): Promise<void> {
    if (this.ws && (this.status === "open" || this.status === "connecting")) {
      return;
    }
    this.setStatus("connecting");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.setStatus("open");
        resolve();
      };
      ws.onerror = () => {
        if (this.status === "connecting") {
          this.setStatus("closed");
          reject(new Error(`WebSocket failed: ${this.url}`));
        }
      };
      ws.onclose = () => {
        this.setStatus("closed");
        this.ws = null;
        for (const [, p] of this.pending) {
          p.reject(new Error("host disconnected"));
        }
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        let msg: WireMessage;
        try {
          msg = JSON.parse(String(ev.data)) as WireMessage;
        } catch {
          this.emit({ type: "error", message: "invalid host message" });
          return;
        }
        if (msg.channel === "event") {
          this.emit(msg.event);
          return;
        }
        if (msg.channel === "response") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg.response);
          }
        }
      };
    });
  }

  async request(cmd: HostCommand): Promise<HostResponse> {
    if (!this.ws || this.status !== "open") {
      await this.connect();
    }
    const ws = this.ws;
    if (!ws || this.status !== "open") {
      return { ok: false, error: "not connected" };
    }
    const id = cmd.id ?? `c${++this.seq}`;
    const body: WireMessage = {
      channel: "request",
      id,
      cmd: { ...cmd, id },
    };
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `timeout waiting for ${cmd.type}` });
      }, 120_000);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify(body));
    });
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }
}
