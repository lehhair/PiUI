const keepAlive = setInterval(() => {}, 1_000)

process.on("disconnect", () => {
  clearInterval(keepAlive)
  process.exit(0)
})
