import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOST_WS_URL,
  type FileContent,
  type FileNode,
  type HostEvent,
} from "@piui/protocol";
import type { HostClient } from "../host/host-types";
import { MockHostTransport } from "../host/mock-host";
import { WsHostTransport } from "../host/ws-host";

type Mode = "ws" | "mock";
type Step = "idle" | "run" | "pass" | "fail";

type Msg = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

const DEFAULT_CWD =
  typeof window !== "undefined" && navigator.platform.toLowerCase().includes("win")
    ? "E:\\dev\\re_agent_UI\\PiUI"
    : "";

export function App() {
  const [mode, setMode] = useState<Mode>("ws");
  const [wsUrl, setWsUrl] = useState(DEFAULT_HOST_WS_URL);
  const [conn, setConn] = useState("idle");
  const [engine, setEngine] = useState("未连接");
  const [cwd, setCwd] = useState("");
  const [cwdInput, setCwdInput] = useState(DEFAULT_CWD);
  const [listPath, setListPath] = useState<string | undefined>();
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: "welcome",
      role: "system",
      text: "验收台：先点「一键自检」。需要两个终端：npm run dev:host  +  npm run dev:app",
    },
  ]);
  const [prompt, setPrompt] = useState("用一句话说明当前工作区里有什么");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [steps, setSteps] = useState<Record<string, Step>>({
    connect: "idle",
    ping: "idle",
    open: "idle",
    list: "idle",
    prompt: "idle",
  });

  const assistantBuf = useRef("");
  const msgEnd = useRef<HTMLDivElement>(null);

  const host: HostClient = useMemo(() => {
    if (mode === "mock") return new MockHostTransport();
    return new WsHostTransport(wsUrl);
  }, [mode, wsUrl]);

  const logAct = useCallback((line: string) => {
    setActivity((a) => [`${new Date().toLocaleTimeString()} ${line}`, ...a].slice(0, 40));
  }, []);

  const setStep = (key: string, s: Step) =>
    setSteps((prev) => ({ ...prev, [key]: s }));

  useEffect(() => {
    msgEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  useEffect(() => {
    setEngine("未连接");
    setError(null);
    setConn(mode === "mock" ? "mock" : "idle");
    setSteps({
      connect: "idle",
      ping: "idle",
      open: "idle",
      list: "idle",
      prompt: "idle",
    });

    const offEvent = host.onEvent((event: HostEvent) => {
      if (event.type === "engine.ready") {
        setEngine(`pi ${event.pi} · host ${event.host} · p${event.protocolVersion}`);
        setStep("connect", "pass");
        logAct(`engine.ready pi=${event.pi}`);
      }
      if (event.type === "agent.text_delta") {
        assistantBuf.current += event.text;
        setMessages((ms) => {
          const last = ms[ms.length - 1];
          if (last?.role === "assistant" && last.id.startsWith("a-stream")) {
            return [...ms.slice(0, -1), { ...last, text: assistantBuf.current }];
          }
          return [
            ...ms,
            { id: `a-stream-${Date.now()}`, role: "assistant", text: assistantBuf.current },
          ];
        });
      }
      if (event.type === "agent.streaming") {
        setStreaming(event.streaming);
        if (event.streaming) {
          assistantBuf.current = "";
        } else if (assistantBuf.current) {
          setStep("prompt", "pass");
          logAct("agent_end");
        }
      }
      if (event.type === "error") {
        setError(event.message);
        logAct(`error: ${event.message}`);
      }
      if (event.type === "agent.event") {
        const t = (event.payload as { type?: string } | null)?.type;
        if (t) logAct(`agent.${t}`);
      }
    });

    const offStatus = host.onStatus?.((s) => {
      setConn(s);
      logAct(`ws ${s}`);
      if (s === "open") setStep("connect", "pass");
      if (s === "closed") setStep("connect", "fail");
    });

    if (mode === "ws") {
      void host.connect?.().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(
          `${msg}\n请先在另一终端运行: npm run dev:host\n应看到 ws://127.0.0.1:8787`,
        );
        setStep("connect", "fail");
      });
    } else {
      setStep("connect", "pass");
      void host.request({ type: "engine.getVersion" }).then((res) => {
        if (res.ok && res.type === "engine.version") {
          setEngine(`pi ${res.pi} · host ${res.host} · p${res.protocolVersion}`);
        }
      });
    }

    return () => {
      offEvent();
      offStatus?.();
      host.close?.();
    };
  }, [host, mode, logAct]);

  async function ensureConnected() {
    if (mode === "ws") await host.connect?.();
  }

  async function doPing() {
    setStep("ping", "run");
    setError(null);
    try {
      await ensureConnected();
      const res = await host.request({ type: "ping" });
      if (!res.ok || res.type !== "pong") {
        setStep("ping", "fail");
        setError(!res.ok ? res.error : "ping failed");
        return false;
      }
      setStep("ping", "pass");
      logAct(`pong protocol=${res.protocolVersion}`);
      return true;
    } catch (e) {
      setStep("ping", "fail");
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function doOpen(path = cwdInput.trim()) {
    if (!path) {
      setError("请填写工作区绝对路径");
      setStep("open", "fail");
      return false;
    }
    setStep("open", "run");
    setBusy(true);
    setError(null);
    try {
      await ensureConnected();
      logAct(`workspace.open ${path}`);
      const res = await host.request({ type: "workspace.open", cwd: path });
      if (!res.ok || res.type !== "workspace.opened") {
        setStep("open", "fail");
        setError(!res.ok ? res.error : "open failed");
        return false;
      }
      setCwd(res.cwd);
      setListPath(undefined);
      setPreview(null);
      setStep("open", "pass");
      logAct(`opened ${res.cwd}`);
      setMessages((ms) => [
        ...ms,
        { id: `sys-${Date.now()}`, role: "system", text: `工作区已打开：${res.cwd}` },
      ]);
      return true;
    } catch (e) {
      setStep("open", "fail");
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function doList(path?: string) {
    setStep("list", "run");
    try {
      const list = await host.request({ type: "workspace.list", path });
      if (!list.ok || list.type !== "workspace.list") {
        setStep("list", "fail");
        setError(!list.ok ? list.error : "list failed");
        return false;
      }
      setNodes(list.nodes);
      setListPath(path);
      setStep("list", "pass");
      logAct(`list ${path ?? "."} → ${list.nodes.length} items`);
      return true;
    } catch (e) {
      setStep("list", "fail");
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function doPrompt(text: string) {
    const t = text.trim();
    if (!t) return false;
    if (!cwd) {
      setError("请先打开工作区");
      return false;
    }
    setStep("prompt", "run");
    setError(null);
    setMessages((ms) => [...ms, { id: `u-${Date.now()}`, role: "user", text: t }]);
    assistantBuf.current = "";
    logAct(`prompt: ${t.slice(0, 80)}`);
    const res = await host.request({ type: "agent.prompt", text: t });
    if (!res.ok) {
      setStep("prompt", "fail");
      setError(res.error);
      return false;
    }
    return true;
  }

  async function runSmoke() {
    setBusy(true);
    setError(null);
    setMessages((ms) => [
      ...ms,
      { id: `sys-${Date.now()}`, role: "system", text: "开始一键自检…" },
    ]);
    try {
      const okPing = await doPing();
      if (!okPing) return;
      const okOpen = await doOpen();
      if (!okOpen) return;
      const okList = await doList();
      if (!okList) return;
      await doPrompt("只回复：PiUI host ok。不要执行工具。");
      setMessages((ms) => [
        ...ms,
        {
          id: `sys-${Date.now()}`,
          role: "system",
          text: "自检请求已发出。若下方出现助手回复且文件树有内容，说明闭环可用。",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function openNode(node: FileNode) {
    setError(null);
    if (node.type === "directory") {
      await doList(node.path);
      return;
    }
    const file = await host.request({ type: "workspace.read", path: node.path });
    if (file.ok && file.type === "workspace.read") {
      setPreview(file.content);
      logAct(`read ${node.path}`);
    } else if (!file.ok) setError(file.error);
  }

  async function goUp() {
    if (!listPath) return;
    const parts = listPath.split(/[/\\]/).filter(Boolean);
    parts.pop();
    const parent = parts.length ? parts.join("/") : undefined;
    await doList(parent);
  }

  function mark(s: Step) {
    if (s === "pass") return "✓";
    if (s === "fail") return "✗";
    if (s === "run") return "…";
    return "·";
  }

  const connBadge =
    mode === "mock"
      ? "ok"
      : conn === "open"
        ? "ok"
        : conn === "connecting"
          ? "warn"
          : "bad";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">PiUI 验收台</span>
          <span className={`badge ${connBadge}`}>
            <span className="dot" />
            {mode === "mock" ? "Mock" : conn}
          </span>
          <span className="badge">{engine}</span>
        </div>
        <div className="topbar-right">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            style={{ width: "auto" }}
          >
            <option value="ws">真 Host (WS)</option>
            <option value="mock">Mock（不启 Host）</option>
          </select>
          {mode === "ws" ? (
            <>
              <input
                style={{ width: 200 }}
                value={wsUrl}
                onChange={(e) => setWsUrl(e.target.value)}
              />
              <button
                type="button"
                onClick={() =>
                  void host.connect?.().catch((e: unknown) =>
                    setError(e instanceof Error ? e.message : String(e)),
                  )
                }
              >
                重连
              </button>
            </>
          ) : null}
          <button type="button" className="primary" disabled={busy} onClick={() => void runSmoke()}>
            一键自检
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="panel">
          <div className="panel-h">步骤 / 工作区</div>
          <div className="panel-b">
            <div className="checklist">
              {(
                [
                  ["connect", "连接 Host"],
                  ["ping", "ping 协议"],
                  ["open", "打开工作区"],
                  ["list", "列文件树"],
                  ["prompt", "发 prompt"],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className={`check ${steps[k]}`}>
                  <span className="check-mark">{mark(steps[k] ?? "idle")}</span>
                  <span>{label}</span>
                </div>
              ))}
            </div>

            <p className="hint">
              终端 1：<code>npm run dev:host</code>
              <br />
              终端 2：<code>npm run dev:app</code>
              <br />
              路径用本机绝对路径。打开工作区可能要几秒（启动 Pi Runtime）。
            </p>

            <div className="path-row">
              <input
                value={cwdInput}
                onChange={(e) => setCwdInput(e.target.value)}
                placeholder="工作区绝对路径"
              />
            </div>
            <div className="row" style={{ marginBottom: "0.6rem" }}>
              <button type="button" disabled={busy} onClick={() => void doOpen()}>
                打开
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setCwdInput(DEFAULT_CWD);
                }}
              >
                填本仓库
              </button>
            </div>

            {cwd ? (
              <div className="cwd">
                {cwd}
                {listPath ? ` / ${listPath}` : ""}
              </div>
            ) : null}

            {listPath ? (
              <button type="button" className="file-item" onClick={() => void goUp()}>
                ⬆ ..
              </button>
            ) : null}

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

            <div className="activity">{activity.join("\n") || "活动日志…"}</div>
          </div>
        </aside>

        <main className="panel chat">
          <div className="panel-h">对话</div>
          <div className="messages">
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.text}
              </div>
            ))}
            {streaming && !assistantBuf.current ? (
              <div className="msg system">助手生成中…</div>
            ) : null}
            <div ref={msgEnd} />
          </div>
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="composer">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="输入消息… Ctrl+Enter 发送"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void doPrompt(prompt).then(() => setPrompt(""));
                }
              }}
            />
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={streaming || !cwd || busy}
                onClick={() => void doPrompt(prompt).then(() => setPrompt(""))}
              >
                发送
              </button>
              <button
                type="button"
                className="danger"
                disabled={!streaming}
                onClick={() => void host.request({ type: "agent.abort" })}
              >
                Abort
              </button>
              <span className="hint" style={{ margin: 0 }}>
                {streaming ? "streaming" : "idle"}
                {!cwd ? " · 先打开工作区" : ""}
              </span>
            </div>
          </div>
        </main>

        <aside className="panel">
          <div className="panel-h">预览</div>
          <div className="panel-b preview">
            {preview ? (
              <>
                <div className="cwd">{preview.path}</div>
                {preview.content}
              </>
            ) : (
              <div className="empty">点左侧文件看内容</div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
