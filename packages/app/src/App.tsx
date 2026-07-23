import { useEffect, useMemo, useState } from "react";
import type { FileContent, FileNode, HostEvent } from "@piui/protocol";
import { MockHostTransport } from "./mock-host";

export function App() {
  const host = useMemo(() => new MockHostTransport(), []);
  const [cwd, setCwd] = useState("");
  const [cwdInput, setCwdInput] = useState("");
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [log, setLog] = useState("");
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [engine, setEngine] = useState("starting…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return host.onEvent((event: HostEvent) => {
      if (event.type === "engine.ready") {
        setEngine(`pi ${event.pi} · host ${event.host} · protocol ${event.protocolVersion}`);
      }
      if (event.type === "agent.text_delta") {
        setLog((s) => s + event.text);
      }
      if (event.type === "agent.streaming") {
        setStreaming(event.streaming);
      }
      if (event.type === "error") {
        setError(event.message);
      }
    });
  }, [host]);

  async function openWorkspace() {
    setError(null);
    const path = cwdInput.trim();
    if (!path) return;
    const res = await host.request({ type: "workspace.open", cwd: path });
    if (!res.ok || res.type !== "workspace.opened") {
      setError(!res.ok ? res.error : "open failed");
      return;
    }
    setCwd(res.cwd);
    setLog("");
    setPreview(null);
    const list = await host.request({ type: "workspace.list" });
    if (list.ok && list.type === "workspace.list") setNodes(list.nodes);
  }

  async function openNode(node: FileNode) {
    setError(null);
    if (node.type === "directory") {
      const list = await host.request({ type: "workspace.list", path: node.path });
      if (list.ok && list.type === "workspace.list") setNodes(list.nodes);
      return;
    }
    const file = await host.request({ type: "workspace.read", path: node.path });
    if (file.ok && file.type === "workspace.read") setPreview(file.content);
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (!text) return;
    setError(null);
    setLog((s) => (s ? `${s}\n\n` : "") + `> ${text}\n`);
    setPrompt("");
    const res = await host.request({ type: "agent.prompt", text });
    if (!res.ok) setError(res.error);
  }

  async function abort() {
    await host.request({ type: "agent.abort" });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="banner">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>PiUI skeleton · {engine}</span>
          <span className="muted">当前为 Mock Host；真实引擎见 packages/host</span>
        </div>
      </div>
      <div className="app" style={{ flex: 1 }}>
        <aside className="panel">
          <div className="panel-header">工作区</div>
          <div className="panel-body">
            <div className="row" style={{ marginBottom: "0.75rem" }}>
              <input
                placeholder="项目路径"
                value={cwdInput}
                onChange={(e) => setCwdInput(e.target.value)}
              />
              <button type="button" onClick={() => void openWorkspace()}>
                打开
              </button>
            </div>
            {cwd ? <div className="muted" style={{ marginBottom: "0.5rem" }}>{cwd}</div> : null}
            {nodes.map((n) => (
              <button
                key={n.path}
                type="button"
                className={`file-item ${n.type === "directory" ? "dir" : ""}`}
                onClick={() => void openNode(n)}
              >
                {n.type === "directory" ? "📁 " : "📄 "}
                {n.name}
              </button>
            ))}
          </div>
        </aside>

        <main className="panel chat">
          <div className="panel-header">对话</div>
          <div className="messages">
            {log || <span className="muted">打开工作区后发送 prompt（Mock 会假流式回复）</span>}
          </div>
          {error ? <div className="panel-body error">{error}</div> : null}
          <div className="composer">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入消息…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void sendPrompt();
                }
              }}
            />
            <div className="row">
              <button type="button" onClick={() => void sendPrompt()} disabled={streaming}>
                发送
              </button>
              <button type="button" onClick={() => void abort()} disabled={!streaming}>
                Abort
              </button>
              <span className="muted">{streaming ? "streaming…" : "idle"} · Ctrl+Enter</span>
            </div>
          </div>
        </main>

        <aside className="panel">
          <div className="panel-header">预览</div>
          <div className="panel-body preview">
            {preview ? preview.content : <span className="muted">点击文件预览</span>}
          </div>
        </aside>
      </div>
    </div>
  );
}
