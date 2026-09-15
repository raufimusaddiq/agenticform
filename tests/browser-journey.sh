#!/bin/sh
set -eu

# Real-browser journey against a disposable clean-install stack. Builds the real
# server/web images, starts postgres + server + web, then drives headless
# Chromium through the shipped proxy. Removes everything it creates.

scope=agenticform-browser-journey-$$
port=${AGENTICFORM_JOURNEY_PORT:-18096}
admin_token=journey-admin-token-0123456789abcdef
secret_key=journey-separate-encryption-key-32chars
project_root=$(mktemp -d)

cleanup() {
  docker rm -f "$scope-web" "$scope-server" "$scope-postgres" >/dev/null 2>&1 || true
  docker network rm "$scope" >/dev/null 2>&1 || true
  docker volume rm "$scope-db" "$scope-worktrees" >/dev/null 2>&1 || true
  rm -rf "$project_root"
}
trap cleanup EXIT INT TERM

echo '== build images =='
docker build -q --network host -t "$scope-server" -f server/Dockerfile . >/dev/null
docker build -q --network host -t "$scope-web" -f web/Dockerfile . >/dev/null

echo '== start stack =='
docker network create "$scope" >/dev/null
docker volume create "$scope-db" >/dev/null
docker volume create "$scope-worktrees" >/dev/null
docker run -d --name "$scope-postgres" --network "$scope" --network-alias postgres \
  -e POSTGRES_DB=agenticform -e POSTGRES_USER=agenticform -e POSTGRES_PASSWORD=agenticform-disposable \
  -v "$scope-db:/var/lib/postgresql/data" postgres:17-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$scope-postgres" pg_isready -U agenticform -d agenticform >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$scope-postgres" pg_isready -U agenticform -d agenticform >/dev/null

docker run -d --name "$scope-server" --network "$scope" --network-alias server \
  -e DATABASE_URL=jdbc:postgresql://postgres:5432/agenticform \
  -e DATABASE_USER=agenticform -e DATABASE_PASSWORD=agenticform-disposable \
  -e AGENTICFORM_ADMIN_TOKEN="$admin_token" -e AGENTICFORM_SECRET_KEY="$secret_key" \
  -e AGENTICFORM_PUBLIC_URL=http://localhost:"$port" -e AGENTICFORM_UI_ORIGIN=http://localhost:"$port" \
  -e AGENTICFORM_PROJECT_ROOT=/srv/apps -e AGENTICFORM_WORKTREE_ROOT=/srv/agenticform/worktrees \
  -e AGENTICFORM_VERSION=browser-journey \
  -v "$project_root:/srv/apps" -v "$scope-worktrees:/srv/agenticform/worktrees" \
  "$scope-server" >/dev/null
docker run -d --name "$scope-web" --network "$scope" --network-alias web \
  -p "127.0.0.1:$port:8080" "$scope-web" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q UP; then break; fi
  sleep 3
done
curl -fsS "http://127.0.0.1:$port/actuator/health" | grep -q UP

echo '== drive headless Chromium =='
docker run --rm --network host -v "$(pwd)/tests:/work" -w /tmp \
  -e JOURNEY_BASE_URL="http://127.0.0.1:$port" -e JOURNEY_ADMIN_TOKEN="$admin_token" \
  mcr.microsoft.com/playwright:v1.49.0-jammy sh -c \
  'npm init -y >/dev/null 2>&1 && npm install playwright@1.49.0 --no-audit --no-fund >/dev/null 2>&1 && cp /work/browser-journey.mjs /tmp/ && node /tmp/browser-journey.mjs'

echo 'BROWSER JOURNEY VERIFIED'
