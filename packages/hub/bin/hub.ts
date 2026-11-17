import { loadConfig } from "../src/config.ts"
import { createHub } from "../src/server.ts"

const config = loadConfig()
const hub = createHub(config)
console.log(`hub listening on ${hub.url}`)

const shutdown = () => {
  hub.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
