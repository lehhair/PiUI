/**
 * Dev placeholder until Tauri IPC / real host process is wired.
 * Simulates protocol so UI can be developed offline.
 */
import {
  PROTOCOL_VERSION,
  type FileContent,
  type FileNode,
  type HostCommand,
  type HostEvent,
  type HostResponse,
} from "@piui/protocol";

type Listener = (event: HostEvent) => void;

export class MockHostTransport {
  private listeners = new Set<Listener>();
  private streaming = false;

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    queueMicrotask(() =>
      listener({
        type: "engine.ready",
        pi: "mock",
        host: "0.1.0-mock",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  async request(cmd: HostCommand): Promise<HostResponse> {
    const id = "id" in cmd ? cmd.id : undefined;
    switch (cmd.type) {
      case "ping":
        return { id, ok: true, type: "pong", protocolVersion: PROTOCOL_VERSION };
      case "engine.getVersion":
        return {
          id,
          ok: true,
          type: "engine.version",
          pi: "mock",
          host: "0.1.0-mock",
          protocolVersion: PROTOCOL_VERSION,
        };
      case "workspace.open":
        return { id, ok: true, type: "workspace.opened", cwd: cmd.cwd };
      case "workspace.list":
        return {
          id,
          ok: true,
          type: "workspace.list",
          nodes: mockTree(cmd.path),
        };
      case "workspace.read":
        return {
          id,
          ok: true,
          type: "workspace.read",
          content: mockFile(cmd.path),
        };
      case "agent.prompt":
        void this.fakeStream(cmd.text);
        return { id, ok: true, type: "agent.prompt.accepted" };
      case "agent.abort":
        this.streaming = false;
        this.emit({ type: "agent.streaming", streaming: false });
        return { id, ok: true, type: "agent.aborted" };
      case "agent.getState":
        return {
          id,
          ok: true,
          type: "agent.state",
          state: { sessionId: "mock", streaming: this.streaming },
        };
      default:
        return { id, ok: false, error: "unknown" };
    }
  }

  private async fakeStream(text: string): Promise<void> {
    this.streaming = true;
    this.emit({ type: "agent.streaming", streaming: true });
    const reply = `（Mock Host）收到：${text}\n接上真实 Host 后这里会是 Pi 流式输出。`;
    for (const ch of reply) {
      if (!this.streaming) break;
      this.emit({ type: "agent.text_delta", text: ch });
      await new Promise((r) => setTimeout(r, 12));
    }
    this.streaming = false;
    this.emit({ type: "agent.streaming", streaming: false });
  }
}

function mockTree(path?: string): FileNode[] {
  if (path && path !== ".") {
    return [
      { name: "nested.ts", path: `${path}/nested.ts`, type: "file" },
    ];
  }
  return [
    { name: "src", path: "src", type: "directory" },
    { name: "package.json", path: "package.json", type: "file" },
    { name: "README.md", path: "README.md", type: "file" },
  ];
}

function mockFile(path: string): FileContent {
  return {
    path,
    mimeType: "text/plain",
    encoding: "utf8",
    content: `// mock content of ${path}\nexport const ok = true\n`,
  };
}
