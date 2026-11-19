import { createRuntime } from "@agenticform/runtime"
import { resolveHarness } from "../src/harness-probe.ts"

/**
 * Real-harness tests spawn or probe a harness binary the owner installs (claude,
 * codex, opencode, ...). They are opt-in: a default run must not start one, so a
 * loaded or fully equipped box behaves like CI.
 */
export const realHarnessEnabled = process.env.AGENTICFORM_REAL_HARNESS === "1"

/** A skip reason for a real-harness test of `id`, or null when it may run. */
export const realHarness = (id: string): string | null => {
  if (!realHarnessEnabled) return `real ${id} harness test skipped: set AGENTICFORM_REAL_HARNESS=1 to run it`
  const definition = createRuntime().harnesses().find((harness) => harness.id === id)
  if (definition === undefined) return `real ${id} harness test skipped: not in the harness catalog`
  if (!resolveHarness(definition).ok) return `real ${id} harness test skipped: ${id} is not installed`
  return null
}

/** Print each skip reason once, so a skipped run says why and names the flag. */
export const reportRealHarness = (ids: readonly string[]): void => {
  for (const id of ids) {
    const reason = realHarness(id)
    if (reason !== null) console.log(reason)
  }
}
