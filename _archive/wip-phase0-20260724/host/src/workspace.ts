import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { FileContent, FileNode } from "@piui/protocol";

const SKIP = new Set([".git", "node_modules", "dist", "target", ".runtime"]);

export class WorkspaceService {
  private cwd: string | null = null;

  open(cwd: string): string {
    this.cwd = resolve(cwd);
    return this.cwd;
  }

  getCwd(): string {
    if (!this.cwd) throw new Error("workspace not open");
    return this.cwd;
  }

  resolveSafe(relPath = "."): string {
    const root = this.getCwd();
    const abs = resolve(root, relPath);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || rel === ".." || abs === root + sep + "..") {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return abs;
  }

  async list(relPath = "."): Promise<FileNode[]> {
    const dir = this.resolveSafe(relPath);
    const entries = await readdir(dir, { withFileTypes: true });
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name !== ".pi" && e.name !== ".env.example") continue;
      const full = join(dir, e.name);
      const path = relative(this.getCwd(), full).split(sep).join("/");
      nodes.push({
        name: e.name,
        path: path || e.name,
        type: e.isDirectory() ? "directory" : "file",
      });
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  async read(relPath: string): Promise<FileContent> {
    const abs = this.resolveSafe(relPath);
    const st = await stat(abs);
    if (!st.isFile()) throw new Error(`not a file: ${relPath}`);
    if (st.size > 2 * 1024 * 1024) throw new Error(`file too large: ${relPath}`);
    const buf = await readFile(abs);
    const path = relative(this.getCwd(), abs).split(sep).join("/");
    const isText = !buf.includes(0);
    if (isText) {
      return {
        path,
        mimeType: "text/plain",
        encoding: "utf8",
        content: buf.toString("utf8"),
      };
    }
    return {
      path,
      mimeType: "application/octet-stream",
      encoding: "base64",
      content: buf.toString("base64"),
    };
  }

  displayName(): string {
    return basename(this.getCwd());
  }
}
