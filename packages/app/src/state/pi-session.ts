import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOST_WS_URL,
  type FileContent,
  type HostEvent,
} from "@piui/protocol";
import type { HostClient } from "../host/host-types";
import { WsHostTransport } from "../host/ws-host";
import type { UiMessage, WorkspaceNode } from "./types";

export type ConnStatus = "idle" | "connecting" | "open" | "closed" | "error";

const DEFAULT_CWD =
  typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("win")
    ? "E:\\dev\\re_agent_UI\\PiUI"
    : "";

export function usePiSession(wsUrl: string = DEFAULT_HOST_WS_URL) {
  const host = useMemo(() => new WsHostTransport(wsUrl) as HostClient, [wsUrl]);

  const [conn, setConn] = useState<ConnStatus>("idle");
  const [engine, setEngine] = useState("—");
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [cwdInput, setCwdInput] = useState(DEFAULT_CWD);
  const [listPath, setListPath] = useState<string | undefined>();
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState(false);

  const assistantId = useRef<string | null>(null);
  const assistantText = useRef("");

  useEffect(() => {
    setConn("connecting");
    setError(null);

    const offStatus = host.onStatus?.((s) => {
      if (s === "open") setConn("open");
      else if (s === "connecting") setConn("connecting");
      else if (s === "closed") setConn("closed");
      else setConn(s as ConnStatus);
    });

    const offEvent = host.onEvent((event: HostEvent) => {
      if (event.type === "engine.ready") {
        setEngine(`pi ${event.pi} · host ${event.host}`);
        setConn("open");
      }
      if (event.type === "error") {
        setError(event.message);
      }
      if (event.type === "agent.streaming") {
        setStreaming(event.streaming);
        if (event.streaming) {
          assistantText.current = "";
          const id = `a-${Date.now()}`;
          assistantId.current = id;
          setMessages((ms) => [
            ...ms,
            { id, role: "assistant", text: "", streaming: true },
          ]);
        } else {
          const id = assistantId.current;
          if (id) {
            setMessages((ms) =>
              ms.map((m) =>
                m.id === id ? { ...m, streaming: false, text: assistantText.current } : m,
              ),
            );
          }
          assistantId.current = null;
        }
      }
      if (event.type === "agent.text_delta") {
        assistantText.current += event.text;
        const id = assistantId.current;
        if (!id) return;
        const text = assistantText.current;
        setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, text } : m)));
      }
      if (event.type === "agent.event") {
        const p = event.payload as { type?: string; toolName?: string; toolCallId?: string } | null;
        if (p?.type === "tool_execution_start" && p.toolCallId) {
          const id = assistantId.current;
          if (!id) return;
          setMessages((ms) =>
            ms.map((m) => {
              if (m.id !== id) return m;
              const tools = [
                ...(m.tools ?? []),
                {
                  id: p.toolCallId!,
                  name: p.toolName ?? "tool",
                  status: "running" as const,
                },
              ];
              return { ...m, tools };
            }),
          );
        }
        if (p?.type === "tool_execution_end" && p.toolCallId) {
          const id = assistantId.current;
          if (!id) return;
          setMessages((ms) =>
            ms.map((m) => {
              if (m.id !== id || !m.tools) return m;
              return {
                ...m,
                tools: m.tools.map((t) =>
                  t.id === p.toolCallId ? { ...t, status: "done" as const } : t,
                ),
              };
            }),
          );
        }
      }
    });

    void host.connect?.().catch((e: unknown) => {
      setConn("error");
      setError(
        e instanceof Error
          ? `${e.message} — 请先运行 npm run dev:host`
          : String(e),
      );
    });

    return () => {
      offEvent();
      offStatus?.();
      host.close?.();
    };
  }, [host]);

  const openWorkspace = useCallback(
    async (path?: string) => {
      const target = (path ?? cwdInput).trim();
      if (!target) {
        setError("请填写工作区绝对路径");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await host.connect?.();
        const res = await host.request({ type: "workspace.open", cwd: target });
        if (!res.ok || res.type !== "workspace.opened") {
          setError(!res.ok ? res.error : "打开失败");
          return;
        }
        setCwd(res.cwd);
        setListPath(undefined);
        setPreview(null);
        setMessages([]);
        const list = await host.request({ type: "workspace.list" });
        if (list.ok && list.type === "workspace.list") {
          setNodes(list.nodes);
        }
        const ver = await host.request({ type: "engine.getVersion" });
        if (ver.ok && ver.type === "engine.version") {
          setEngine(`pi ${ver.pi} · host ${ver.host}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [cwdInput, host],
  );

  const listDir = useCallback(
    async (path?: string) => {
      const list = await host.request({ type: "workspace.list", path });
      if (!list.ok || list.type !== "workspace.list") {
        setError(!list.ok ? list.error : "list failed");
        return;
      }
      setNodes(list.nodes);
      setListPath(path);
    },
    [host],
  );

  const openFile = useCallback(
    async (path: string) => {
      const file = await host.request({ type: "workspace.read", path });
      if (file.ok && file.type === "workspace.read") setPreview(file.content);
      else if (!file.ok) setError(file.error);
    },
    [host],
  );

  const openNode = useCallback(
    async (node: WorkspaceNode) => {
      if (node.type === "directory") await listDir(node.path);
      else await openFile(node.path);
    },
    [listDir, openFile],
  );

  const goUp = useCallback(async () => {
    if (!listPath) return;
    const parts = listPath.split(/[/\\]/).filter(Boolean);
    parts.pop();
    await listDir(parts.length ? parts.join("/") : undefined);
  }, [listDir, listPath]);

  const sendPrompt = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      if (!cwd) {
        setError("请先打开工作区");
        return;
      }
      setError(null);
      setMessages((ms) => [
        ...ms,
        { id: `u-${Date.now()}`, role: "user", text: t },
      ]);
      const res = await host.request({ type: "agent.prompt", text: t });
      if (!res.ok) setError(res.error);
    },
    [cwd, host],
  );

  const abort = useCallback(async () => {
    await host.request({ type: "agent.abort" });
  }, [host]);

  const reconnect = useCallback(async () => {
    setError(null);
    try {
      await host.connect?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [host]);

  return {
    host,
    conn,
    engine,
    error,
    setError,
    cwd,
    cwdInput,
    setCwdInput,
    listPath,
    nodes,
    preview,
    messages,
    streaming,
    busy,
    openWorkspace,
    openNode,
    goUp,
    sendPrompt,
    abort,
    reconnect,
    defaultCwd: DEFAULT_CWD,
  };
}
