import { resolve } from "node:path"
import { createRuntime } from "../src/index.ts"

// bun packages/runtime/examples/run.ts codex . "Summarise this repository"
const [harness, directory, prompt] = process.argv.slice(2)
if (!harness || !directory || !prompt) {
  console.error("Usage: run.ts <harness> <directory> <prompt>")
  process.exit(2)
}

const run = createRuntime().run({
  harness,
  cwd: resolve(directory),
  prompt,
  onPermission: (request) => {
    console.error(`\ndenied: ${request.title ?? request.toolCallId}`)
    return "deny"
  },
})

for await (const event of run.events()) {
  if (event.type === "message.delta") process.stdout.write(event.text)
  if (event.type === "tool.call") console.error(`\ntool: ${event.title ?? event.toolCallId}`)
}

const result = await run.result()
console.error(`\n${result.status}${result.error ? `: ${result.error.code} ${result.error.message}` : ""}`)
process.exit(result.status === "completed" ? 0 : 1)
