# Sprint 15 — Seamless Self-Hosted Alpha Checklist

Scope: ship the supported path for daily self-hosted use. Alpha may break between releases; normal installation and operation may not require internal knowledge.

## Release stack

- [x] Root Compose starts PostgreSQL, control plane, and web UI from release images.
- [x] Add `.env.example` with the minimal required configuration.
- [x] Persist PostgreSQL and worktrees in named volumes.
- [x] Add database, control-plane, and dependency health gates.
- [x] Expose build/version metadata through `/actuator/info`.
- [x] Add a tag-triggered workflow that publishes server, web, and node images to GHCR.

## First use and nodes

- [x] Keep the single-owner admin-token bootstrap in the browser UI; token is browser-session only.
- [x] Register a Git project from the UI.
- [x] Create a one-time node enrollment and copy one setup command from the UI.
- [x] Show node connectivity separately from Codex install/authentication/version readiness.
- [x] Surface protocol incompatibility and unavailable/authentication-required runtime states.

## Operator path

- [x] Document install, restart, update, backup, restore, networking, and reverse-proxy requirements.
- [x] Document supported health endpoints and outbound-only node connectivity.
- [x] Preserve automatic Flyway migration at control-plane startup.

## Verification

- [x] `docker compose --env-file .env.example config` after supplying required secrets.
- [x] `cd server && mvn test` (PR #17 CI, September 13, 2026).
- [x] `cd web && npm run build` (PR #17 CI, September 13, 2026).
- [x] `cd node && go test ./...` (PR #17 CI, September 13, 2026).
- [x] Deploy the current Alpha stack with Docker/Traefik at `https://agentic.investdx.biz.id`; clean startup and public health/API checks passed September 13, 2026.
- [ ] Exercise the release path against real repositories and execution nodes; record dogfood findings before claiming Alpha exit.

## Exit gate

- [ ] Clean-server installation, first useful agent, approval/message/operation loop, restart/reconnect, and backup/restore are exercised as the documented operator path.
