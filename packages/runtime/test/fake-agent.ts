import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"

/** A real ACP agent process whose behaviour is chosen by FAKE_SCENARIO. */
const scenario = process.env.FAKE_SCENARIO ?? "ok"
const capabilities = JSON.parse(process.env.FAKE_CAPS ?? "{}") as acp.AgentCapabilities
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let cancelled: (() => void) | null = null
let turns = 0

const say = (client: acp.AgentContext, sessionId: string, text: string) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  })

const untilCancelled = () => new Promise<void>((resolve) => (cancelled = resolve))

acp
  .agent({ name: "fake" })
  .onRequest(acp.methods.agent.initialize, async () => {
    if (scenario === "hang-initialize") await new Promise(() => {})
    return {
      protocolVersion: scenario === "wrong-version" ? 99 : acp.PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      agentInfo: { name: "fake", version: "1.0.0" },
    }
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    if (scenario === "auth") throw new acp.RequestError(-32000, "Authentication required")
    if (scenario === "hang-session") await new Promise(() => {})
    return { sessionId: "session-1" }
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const sessionId = params.sessionId
    const input = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("")
    turns += 1
    switch (scenario) {
      case "permission": {
        const response = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "Write file", kind: "edit" },
          options: [
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "once", name: "Once", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        })
        const chosen = response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled"
        await say(client, sessionId, chosen)
        return { stopReason: "end_turn" }
      }
      case "permission-always-only": {
        const response = await client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "Write file" },
          options: [
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        })
        await say(client, sessionId, response.outcome.outcome === "selected" ? response.outcome.optionId : "cancelled")
        return { stopReason: "end_turn" }
      }
      case "cancellable":
        await say(client, sessionId, `working on: ${input}`)
        if (turns > 1) return { stopReason: "end_turn" }
        await untilCancelled()
        return { stopReason: "cancelled" }
      case "ignore-cancel":
        await say(client, sessionId, "busy")
        await new Promise(() => {})
        return { stopReason: "end_turn" }
      case "exit":
        await say(client, sessionId, "about to crash")
        process.exit(3)
      case "error":
        throw new acp.RequestError(-32603, "Internal failure")
      case "max-tokens":
        return { stopReason: "max_tokens" }
      case "child": {
        const child = spawn("sleep", ["300"], { stdio: "ignore" })
        await say(client, sessionId, String(child.pid))
        return { stopReason: "end_turn" }
      }
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: "another-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ignored" } },
    })
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } },
    })
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read", status: "pending" },
    })
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" },
    })
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "plan", entries: [{ content: "Step", priority: "medium", status: "pending" }] },
    })
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    })
    await say(client, sessionId, "hello ")
    await wait(1)
    await say(client, sessionId, "world")
    return { stopReason: "end_turn" }
  })
  .onNotification(acp.methods.agent.session.cancel, () => cancelled?.())
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  )
