# Self-Hosted Alpha

Agenticform Alpha runs from published images. No source build, SQL, curl, or manual Flyway step is part of the supported path.

## Install

Copy the release `docker-compose.yml` and `.env.example` to the server, then create `.env`:

```bash
cp .env.example .env
openssl rand -hex 32
```

Set the generated value as `AGENTICFORM_ADMIN_TOKEN`. Set `POSTGRES_PASSWORD` to a different strong value. Replace every `<release-tag>` image value with the same published release tag. For a public installation, set `AGENTICFORM_PUBLIC_URL` and `AGENTICFORM_UI_ORIGIN` to the HTTPS browser origin, and replace `AGENTICFORM_NODE_IMAGE` with the published immutable digest from that release.

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Open `AGENTICFORM_PUBLIC_URL`, enter the admin token once, then register a project and use **Execution nodes → Add execution node**. Copy the generated command to a non-root target machine. The target needs Docker and a Codex login or `OPENAI_API_KEY`; its node daemon only connects outbound to the control plane.

## Runtime readiness

The node card separates control-plane connectivity from Codex readiness:

- `Codex runtime missing`: node image/runtime installation problem.
- `Codex authentication required`: authenticate Codex on the target or provide its supported node-local credential.
- `Node protocol incompatible`: upgrade the node image to the control-plane release.
- `Ready`: placement may still reject insufficient trust, capacity, project, or credential conditions; the dispatch error is returned to the UI.

## Restart and update

Named `agenticform-postgres` and `worktrees` volumes preserve durable state across ordinary container restarts.

```bash
docker compose pull
docker compose up -d
```

Use a tested release tag/digest for normal deployments. Alpha does not promise cross-release schema compatibility; take a backup before changing `AGENTICFORM_VERSION`.

## Backup and restore

Run from the directory containing `.env`:

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "backups/agenticform-$(date +%F).dump"
```

Restore only into a stopped/recreated Alpha database. Keep the old volume until verification completes:

```bash
docker compose down
docker volume rm agenticform_agenticform-postgres
docker compose up -d postgres
cat backups/agenticform-YYYY-MM-DD.dump | docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists
docker compose up -d
```

## Reverse proxy and networking

Publish only the web port (`AGENTICFORM_WEB_PORT`, default `8080`). Terminate TLS at Caddy, Traefik, Nginx, or Cloudflare. Proxy `/`, `/api/`, and `/actuator/` to the web service. Preserve HTTP/1.1 streaming and disable buffering for `/api/events/stream`; the bundled web proxy already forwards it to the control plane.

Use `GET /actuator/health` for readiness/liveness and `GET /actuator/info` for release metadata. The browser origin must match `AGENTICFORM_UI_ORIGIN`. Nodes require outbound HTTPS to `AGENTICFORM_PUBLIC_URL`; no inbound node port, SSH, or exposed Codex App Server is used.
