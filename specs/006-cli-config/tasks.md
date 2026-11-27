# Tasks: Unified CLI Configuration

- [x] Add `@agenticform/protocol/config` (`packages/protocol/src/config.ts`) with fail-closed validation, atomic `0600` writes, and redaction.
- [x] Wire `config.json` precedence into `client`, `hub`, `node`, `cli`, and `mcp` (plus `identity.json` `hubUrl` fallback on enrolled nodes).
- [x] Implement `af init hub|client|node` and `af config path|show|set|unset` in `packages/cli/bin/af.ts`.
- [x] Split `README.md` configuration into Quick Setup + essential env vars and move full tuning reference to `docs/configuration.md`.
- [x] Add unit, precedence, redaction, and CLI/MCP zero-env E2E tests across `protocol`, `hub`, `node`, and `cli`.
