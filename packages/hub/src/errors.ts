import type { ErrorCode } from "@agenticform/protocol"

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  payload_too_large: 413,
  forbidden: 403,
  not_found: 404,
  version_unsupported: 409,
  idempotency_conflict: 409,
  fence_stale: 409,
  events_pending: 409,
  lease_not_held: 409,
  ambiguous_replay: 409,
  capability_missing: 422,
  no_eligible_node: 422,
  recovery_precondition_failed: 422,
  workspace_missing: 422,
  name_taken: 409,
  permission_resolved: 409,
  permission_expired: 409,
  permission_unsupported: 409,
  parent_not_found: 404,
  depth_exceeded: 422,
  script_invalid: 400,
  snapshot_incompatible: 409,
  workflow_limit_exceeded: 422,
  internal: 500,
}

export class HubError extends Error {
  readonly status: number

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "HubError"
    this.status = STATUS[code]
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new HubError(code, message)
}

/** Machine authentication failures are indistinguishable, whatever actually failed (N8.4). */
export function unauthorized(): never {
  fail("unauthorized", "unauthorized")
}
