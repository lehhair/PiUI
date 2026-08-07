// Pi 0.84 does not expose its Node CLI through package exports. Keep this
// relative import for the packaged CLI fallback.
await import("../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
