---

description: "Task list for Runtime Foundation"
---

# Tasks: Runtime Foundation

**Input**: Design documents from `/specs/001-runtime-foundation/`

**Tests**: Required by FR-015.

## Phase 1: Setup

- [x] T001 Create Bun workspace in package.json and tsconfig.json
- [x] T002 Create packages/runtime/package.json and pin the ACP SDK

## Phase 2: Foundation

- [x] T003 Define contracts in packages/runtime/src/types.ts
- [x] T004 Implement replayable events in packages/runtime/src/event-log.ts
- [x] T005 Define the driver boundary in packages/runtime/src/driver.ts
- [x] T006 Add the harness catalog in packages/runtime/src/harnesses.ts
- [x] T007 Build the fake agent process in packages/runtime/test/fake-agent.ts

## Phase 3: User Story 1 (P1)

- [x] T008 [US1] Add run lifecycle in packages/runtime/src/runtime.ts
- [x] T009 [US1] Add spawn, handshake, session and prompt in packages/runtime/src/acp-driver.ts
- [x] T010 [US1] Add run and streaming tests in packages/runtime/test/runtime.test.ts

## Phase 4: User Story 2 (P1)

- [x] T011 [US2] Add capability mapping and requirement checks in packages/runtime/src/acp-driver.ts
- [x] T012 [US2] Add refusal, auth and protocol tests in packages/runtime/test/runtime.test.ts

## Phase 5: User Story 3 (P2)

- [x] T013 [US3] Add permission handling in packages/runtime/src/acp-driver.ts
- [x] T014 [US3] Add cancel, steer and process stop handling
- [x] T015 [US3] Add permission, cancel, steer and process-death tests

## Phase 6: User Story 4 (P2)

- [x] T016 [US4] Build the suite in packages/runtime/test/conformance.ts
- [x] T017 [US4] Add opt-in real harness selection
- [x] T018 [P] Add the local example in packages/runtime/examples/run.ts

## Phase 7: Polish

- [x] T019 Add runtime CI job
- [x] T020 Amend repository documentation
