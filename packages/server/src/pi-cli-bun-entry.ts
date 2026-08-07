// Pi 0.84 does not expose its Bun CLI through package exports. Keep this
// relative import so Bun can bundle the published file without the subpath
// export check.
await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/bun/cli.js")
