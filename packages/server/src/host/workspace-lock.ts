import path from "node:path"
import { acquireDirectoryLock, type DirectoryLock } from "../pi/directory-lock.ts"
import { piuiDataDir } from "./auth-token.ts"

export async function acquireWorkspaceMutationLock(
  root: string,
  options: { namespace?: string; staleMs?: number; timeoutMs?: number } = {},
): Promise<DirectoryLock> {
  return acquireDirectoryLock(
    options.namespace ?? path.join(piuiDataDir(), "workspace-locks"),
    `workspace:${path.resolve(root)}`,
    { ...options, busyCode: "WORKSPACE_BUSY" },
  )
}
