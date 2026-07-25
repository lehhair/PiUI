import { rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

for (const packageName of ["app", "pi-worker", "protocol", "server"]) {
  rmSync(path.join(root, "packages", packageName, "dist"), { recursive: true, force: true })
}
