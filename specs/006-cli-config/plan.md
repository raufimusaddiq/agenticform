# Implementation Plan: Unified CLI Configuration

- **`packages/protocol/src/config.ts`** (exported as `@agenticform/protocol/config`):
  - `resolveConfigPath`, `defaultConfigPath`, `loadConfigFile`, `saveConfigFile`, `validateConfigFile`, `setConfigValue`, `unsetConfigValue`, `redactedConfigView`.
- **`packages/client/src/index.ts`**:
  - `envToken`, `resolveHubUrl`, `resolveClientConfig` reading `env` then `config.json`.
- **`packages/hub/src/config.ts`**:
  - `loadConfig` reads `config.json` for `adminToken`, `hub.publicUrl`, `hub.stateDir`, `hub.dbPath`, `hub.port`, `hub.maxDepth`, `hub.workflowTimeoutMs`, `hub.workflowMaxChildRuns` with `env > file > default`.
- **`packages/node/src/config.ts` & `packages/node/bin/node.ts`**:
  - `loadConfig` reads `config.json` for `node.stateDir` and `hubUrl`, falling back to `loadIdentity(stateDir)?.hubUrl` after enrollment; CLI falls back to `node.name`, `node.slots`, `node.harnesses`, `node.capabilities`.
- **`packages/cli/bin/af.ts` & `packages/mcp/bin/mcp.ts`**:
  - Both resolve hub URL & token via `resolveClientConfig()`.
  - `af` adds `af init hub|client|node` and `af config path|show|set|unset`.
- **Docs**: `docs/configuration.md` + simplified `README.md`.
