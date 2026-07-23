import { useEffect, useRef, useState } from "react";
import { DEFAULT_HOST_WS_URL } from "@piui/protocol";
import {
  FolderIcon,
  FolderOpenIcon,
  FileIcon,
  SidebarIcon,
  PanelRightIcon,
  SendIcon,
  StopIcon,
  RetryIcon,
  ChevronUpIcon,
} from "../components/Icons";
import { usePiSession } from "../state/pi-session";
import type { UiMessage } from "../state/types";

export function ShellApp() {
  const s = usePiSession(DEFAULT_HOST_WS_URL);
  const [prompt, setPrompt] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [s.messages, s.streaming]);

  const connClass =
    s.conn === "open"
      ? "text-[hsl(var(--success-100))]"
      : s.conn === "connecting"
        ? "text-[hsl(var(--warning-100))]"
        : "text-[hsl(var(--danger-100))]";

  return (
    <div className="flex h-full flex-col bg-[hsl(var(--bg-100))] text-[hsl(var(--text-100))]">
      {/* 顶栏 — 对齐旧壳气质 */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[hsl(var(--border-200))] bg-[hsl(var(--bg-000))] px-3">
        <span className="text-sm font-semibold tracking-wide text-[hsl(var(--text-000))]">
          PiUI
        </span>
        <span className={`text-xs ${connClass}`}>● {s.conn}</span>
        <span className="truncate text-xs text-[hsl(var(--text-400))]">{s.engine}</span>
        <div className="ml-auto flex items-center gap-1">
          <IconBtn title="侧栏" onClick={() => setLeftOpen((v) => !v)}>
            <SidebarIcon size={16} />
          </IconBtn>
          <IconBtn title="右栏" onClick={() => setRightOpen((v) => !v)}>
            <PanelRightIcon size={16} />
          </IconBtn>
          <IconBtn title="重连 Host" onClick={() => void s.reconnect()}>
            <RetryIcon size={16} />
          </IconBtn>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：工作区 */}
        {leftOpen ? (
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-[hsl(var(--border-200))] bg-[hsl(var(--bg-000))]">
            <div className="border-b border-[hsl(var(--border-200))] px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--text-400))]">
              工作区
            </div>
            <div className="flex flex-col gap-2 p-2">
              <input
                className="w-full rounded-lg border border-[hsl(var(--border-200))] bg-[hsl(var(--bg-100))] px-2 py-1.5 text-xs outline-none focus:border-[hsl(var(--accent-main-100))]"
                value={s.cwdInput}
                onChange={(e) => s.setCwdInput(e.target.value)}
                placeholder="绝对路径"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={s.busy}
                  onClick={() => void s.openWorkspace()}
                  className="flex-1 rounded-lg bg-[hsl(var(--accent-main-000))] px-2 py-1.5 text-xs font-medium text-[hsl(var(--oncolor-100,0_0%_100%))] disabled:opacity-50"
                >
                  {s.busy ? "打开中…" : "打开"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-[hsl(var(--border-200))] px-2 py-1.5 text-xs text-[hsl(var(--text-300))]"
                  onClick={() => s.setCwdInput(s.defaultCwd)}
                >
                  本仓库
                </button>
              </div>
              {s.cwd ? (
                <div className="break-all text-[10px] text-[hsl(var(--text-400))]">
                  {s.cwd}
                  {s.listPath ? ` / ${s.listPath}` : ""}
                </div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
              {s.listPath ? (
                <FileRow
                  icon={<ChevronUpIcon size={14} />}
                  label=".."
                  onClick={() => void s.goUp()}
                />
              ) : null}
              {s.nodes.map((n) => (
                <FileRow
                  key={n.path}
                  icon={
                    n.type === "directory" ? (
                      <FolderOpenIcon size={14} className="text-[hsl(var(--accent-main-100))]" />
                    ) : (
                      <FileIcon size={14} className="text-[hsl(var(--text-400))]" />
                    )
                  }
                  label={n.name}
                  onClick={() => void s.openNode(n)}
                />
              ))}
              {!s.cwd ? (
                <p className="px-2 py-4 text-center text-xs text-[hsl(var(--text-400))]">
                  打开目录后显示文件树
                </p>
              ) : null}
            </div>
          </aside>
        ) : null}

        {/* 中：对话 */}
        <main className="flex min-w-0 flex-1 flex-col bg-[hsl(var(--bg-100))]">
          <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
            {s.messages.length === 0 ? (
              <EmptyChat connected={s.conn === "open"} hasCwd={!!s.cwd} />
            ) : (
              <div className="mx-auto flex max-w-3xl flex-col gap-3">
                {s.messages.map((m) => (
                  <MessageBubble key={m.id} msg={m} />
                ))}
                <div ref={endRef} />
              </div>
            )}
          </div>

          {s.error ? (
            <div className="mx-3 mb-2 rounded-lg border border-[hsl(var(--danger-200))] bg-[hsl(var(--danger-bg))] px-3 py-2 text-xs text-[hsl(var(--danger-100))] whitespace-pre-wrap">
              {s.error}
            </div>
          ) : null}

          <div className="border-t border-[hsl(var(--border-200))] bg-[hsl(var(--bg-000))] p-3">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              <textarea
                className="min-h-[72px] w-full resize-y rounded-xl border border-[hsl(var(--border-200))] bg-[hsl(var(--bg-100))] px-3 py-2 text-sm outline-none focus:border-[hsl(var(--accent-main-100))]"
                value={prompt}
                placeholder={s.cwd ? "发给 Pi… Ctrl+Enter 发送" : "先打开工作区"}
                disabled={!s.cwd}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    const t = prompt;
                    setPrompt("");
                    void s.sendPrompt(t);
                  }
                }}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!s.cwd || s.streaming}
                  className="inline-flex items-center gap-1 rounded-lg bg-[hsl(var(--accent-main-000))] px-3 py-1.5 text-sm font-medium text-[hsl(var(--oncolor-100,0_0%_100%))] disabled:opacity-40"
                  onClick={() => {
                    const t = prompt;
                    setPrompt("");
                    void s.sendPrompt(t);
                  }}
                >
                  <SendIcon size={14} />
                  发送
                </button>
                <button
                  type="button"
                  disabled={!s.streaming}
                  className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--danger-200))] px-3 py-1.5 text-sm text-[hsl(var(--danger-100))] disabled:opacity-40"
                  onClick={() => void s.abort()}
                >
                  <StopIcon size={14} />
                  Abort
                </button>
                <span className="text-xs text-[hsl(var(--text-400))]">
                  {s.streaming ? "streaming" : "idle"}
                </span>
              </div>
            </div>
          </div>
        </main>

        {/* 右：预览 */}
        {rightOpen ? (
          <aside className="flex w-[300px] shrink-0 flex-col border-l border-[hsl(var(--border-200))] bg-[hsl(var(--bg-000))]">
            <div className="border-b border-[hsl(var(--border-200))] px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-[hsl(var(--text-400))]">
              预览
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-[hsl(var(--text-200))] whitespace-pre-wrap break-words">
              {s.preview ? (
                <>
                  <div className="mb-2 text-[10px] text-[hsl(var(--text-400))]">
                    {s.preview.path}
                  </div>
                  {s.preview.content}
                </>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-[hsl(var(--text-400))]">
                  选择文件预览
                </div>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded-md p-1.5 text-[hsl(var(--text-300))] hover:bg-[hsl(var(--bg-200))] hover:text-[hsl(var(--text-100))]"
    >
      {children}
    </button>
  );
}

function FileRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-[hsl(var(--text-200))] hover:bg-[hsl(var(--bg-200))]"
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function EmptyChat({ connected, hasCwd }: { connected: boolean; hasCwd: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <FolderIcon size={36} className="text-[hsl(var(--text-500))]" />
      <p className="text-sm text-[hsl(var(--text-300))]">Pi 本地客户端</p>
      <p className="max-w-sm text-xs text-[hsl(var(--text-400))]">
        {!connected
          ? "Host 未连接：另开终端运行 npm run dev:host"
          : !hasCwd
            ? "左侧打开本机项目目录，即可对话"
            : "在下方输入消息"}
      </p>
    </div>
  );
}

function MessageBubble({ msg }: { msg: UiMessage }) {
  if (msg.role === "system") {
    return (
      <div className="self-center text-center text-xs text-[hsl(var(--text-400))]">{msg.text}</div>
    );
  }
  const isUser = msg.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[90%] rounded-2xl border px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "border-[hsl(var(--border-200))] bg-[hsl(var(--bg-200))]"
            : "border-[hsl(var(--border-200))] bg-[hsl(var(--bg-000))]"
        }`}
      >
        {msg.text || (msg.streaming ? "…" : "")}
      </div>
      {msg.tools?.length ? (
        <div className="flex max-w-[90%] flex-col gap-1">
          {msg.tools.map((t) => (
            <div
              key={t.id}
              className="rounded-lg border border-[hsl(var(--border-200))] bg-[hsl(var(--bg-000))] px-2 py-1 font-mono text-[11px] text-[hsl(var(--text-300))]"
            >
              {t.status === "running" ? "…" : "✓"} {t.name}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
