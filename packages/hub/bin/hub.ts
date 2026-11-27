import { loadConfig } from "../src/config.ts"
import { createHub } from "../src/server.ts"

const config = loadConfig()
const hub = createHub(config)
console.log(`hub listening on ${hub.url}`)

let stopping = false
const shutdown = async (): Promise<void> => {
  if (stopping) return
  stopping = true
  try {
    await Promise.race([
      hub.suspendWorkflows(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ])
  } finally {
    hub.stop()
    process.exit(0)
  }
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
