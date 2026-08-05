import { copyFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = join(root, "packages", "pi-worker", "test-fixtures", "extensions", "piui-panel-test.ts")
const target = join(homedir(), ".pi", "agent", "extensions", "piui-panel-test.ts")

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`Installed PiUI test extension at ${target}`)
