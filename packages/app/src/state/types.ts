/** PiUI 自有 UI 模型 — 不是 OpenCode Message parts */

export type UiToolCard = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string;
};

export type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tools?: UiToolCard[];
  streaming?: boolean;
};

export type WorkspaceNode = {
  name: string;
  path: string;
  type: "file" | "directory";
};
