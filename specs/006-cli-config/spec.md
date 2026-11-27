# Feature Specification: Unified CLI Configuration

**Feature Branch**: `feat/006-cli-config`

**Created**: 2026-11-27

**Status**: Implemented

## Scope

Simplify day-to-day Agenticform configuration so operators, node machines, and CLI/MCP callers do not have to manage 34 separate environment variables manually.

1. **Unified JSON config file (`@agenticform/protocol/config`)**: stored at `~/.config/agenticform/config.json` (or `$XDG_CONFIG_HOME/agenticform/config.json`, or `AGENTICFORM_CONFIG`), written atomically at mode `0600`.
2. **Consistent precedence across all packages**: `env var` > `config.json` > `identity.json` (`hubUrl` on enrolled nodes) > `built-in defaults`.
3. **CLI setup & management (`af init` and `af config`)**: interactive-free, scriptable subcommands (`af init hub|client|node`, `af config path|show|set|unset`) with fail-closed validation and stdin-only secret input.
4. **Simplified documentation**: concise Quick Setup + 5 essential env vars in `README.md`, with full tuning reference in `docs/configuration.md`.

## Invariants

- Secrets (`token`, `adminToken`) are never accepted on CLI argv/flags and never printed by `af config show` or `af init`.
- Synthetic empty environment maps (`{}`) in unit tests never leak the operator's real home config file (`resolveConfigPath({}) === null`).
- Invalid or corrupt `config.json` fails closed with an explicit error instead of silently falling back.
