# Implementation Plan: Runtime Foundation

**Branch**: `001-runtime-foundation` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-runtime-foundation/spec.md`

## Summary

Add a Bun workspace with `@agenticform/runtime`: one run API over a driver boundary, one ACP v1 driver, a harness catalog, and a conformance suite backed by a fake agent process.

## Technical Context

**Language/Version**: TypeScript on Bun 1.4.4

**Primary Dependencies**: `@agentclientprotocol/sdk` 2.4.0

**Storage**: N/A

**Testing**: `bun test` with real child processes

**Target Platform**: Linux and macOS

**Project Type**: Library

**Performance Goals**: No target in this feature; memory is measured with `node` and `hub`

**Constraints**: ACP v1 only, fail closed, no credentials handled

**Scale/Scope**: One process per run

## Constitution Check

| Principle | Result |
|---|---|
| I. Execution, Not Orchestration | Pass: no tasks or planning |
| II. Library First | Pass: no server dependency |
| III. One Contract, Honest Differences | Pass: capabilities, profiles, emulated steer |
| IV. Fail Closed | Pass: default deny, no retries, named errors |
| V. Bring Your Own Harness | Pass: no install or auth handling |
| VI. Proof Over Claims | Pass: catalog verification level, conformance suite |
| VII. Stay Small | Pass: one driver, no persistence |

## Project Structure

### Documentation (this feature)

```text
specs/001-runtime-foundation/
├── plan.md
├── spec.md
├── research.md
├── tasks.md
└── contracts/runtime-api.md
```

### Source Code (repository root)

```text
package.json
tsconfig.json
packages/runtime/
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── harnesses.ts
│   ├── event-log.ts
│   ├── driver.ts
│   ├── acp-driver.ts
│   └── runtime.ts
├── test/
│   ├── fake-agent.ts
│   ├── conformance.ts
│   └── runtime.test.ts
└── examples/run.ts
```

**Structure Decision**: One workspace package now. `node`, `hub` and `client` become sibling packages in later specs.

## Complexity Tracking

No constitution exceptions.
