import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  type AgentStateSnapshot,
  type HostCommand,
  type HostEvent,
  type HostResponse,
} from "@piui/protocol";
import { WorkspaceService } from "./workspace.js";

const HOST_VERSION = "0.1.0";

type Listener = (event: HostEvent) => void;

export class PiuiHost {
  private readonly workspace = new WorkspaceService();
  private runtime: AgentSessionRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<Listener>();
  private piVersion = "unknown";

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const l of this.listeners) l(event);
  }

  async start(piVersion = "unknown"): Promise<void> {
    this.piVersion = piVersion;
    this.emit(this.readyEvent());
  }

  readyEvent() {
    return {
      type: "engine.ready" as const,
      pi: this.piVersion,
      host: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  async handle(cmd: HostCommand): Promise<HostResponse> {
    const id = "id" in cmd ? cmd.id : undefined;
    try {
      switch (cmd.type) {
        case "ping":
          return { id, ok: true, type: "pong", protocolVersion: PROTOCOL_VERSION };
        case "engine.getVersion":
          return {
            id,
            ok: true,
            type: "engine.version",
            pi: this.piVersion,
            host: HOST_VERSION,
            protocolVersion: PROTOCOL_VERSION,
          };
        case "workspace.open":
          return await this.openWorkspace(cmd.cwd, id);
        case "workspace.list":
          return {
            id,
            ok: true,
            type: "workspace.list",
            nodes: await this.workspace.list(cmd.path),
          };
        case "workspace.read":
          return {
            id,
            ok: true,
            type: "workspace.read",
            content: await this.workspace.read(cmd.path),
          };
        case "agent.prompt":
          return await this.prompt(cmd.text, id);
        case "agent.abort":
          await this.runtime?.session.abort();
          return { id, ok: true, type: "agent.aborted" };
        case "agent.getState":
          return { id, ok: true, type: "agent.state", state: this.snapshot() };
        default:
          return { id, ok: false, error: `unknown command`, code: "unknown_command" };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", message });
      return { id, ok: false, error: message };
    }
  }

  private async openWorkspace(cwd: string, id?: string): Promise<HostResponse> {
    const opened = this.workspace.open(cwd);
    await this.replaceRuntime(opened);
    return { id, ok: true, type: "workspace.opened", cwd: opened };
  }

  private async replaceRuntime(cwd: string): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.runtime) {
      await this.runtime.dispose();
      this.runtime = null;
    }

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: runtimeCwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({ cwd: runtimeCwd });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(cwd),
    });

    await this.runtime.session.bindExtensions({});
    this.unsubscribe = this.runtime.session.subscribe((event) => {
      this.emit({ type: "agent.event", payload: event });
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.emit({ type: "agent.text_delta", text: event.assistantMessageEvent.delta });
      }
      if (event.type === "agent_start") {
        this.emit({ type: "agent.streaming", streaming: true });
      }
      if (event.type === "agent_end") {
        this.emit({ type: "agent.streaming", streaming: false });
      }
    });
  }

  private async prompt(text: string, id?: string): Promise<HostResponse> {
    if (!this.runtime) throw new Error("open a workspace first");
    void this.runtime.session.prompt(text).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", message });
      this.emit({ type: "agent.streaming", streaming: false });
    });
    return { id, ok: true, type: "agent.prompt.accepted" };
  }

  private snapshot(): AgentStateSnapshot {
    const session = this.runtime?.session;
    if (!session) {
      return { sessionId: "", streaming: false };
    }
    const model = session.model;
    return {
      sessionId: session.sessionId,
      sessionPath: session.sessionFile,
      streaming: session.isStreaming,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name ?? model.id }
        : undefined,
      thinkingLevel: session.thinkingLevel,
    };
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.runtime) {
      await this.runtime.dispose();
      this.runtime = null;
    }
    this.listeners.clear();
  }
}
