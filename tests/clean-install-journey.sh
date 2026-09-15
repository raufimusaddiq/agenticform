#!/bin/sh
set -eu

# Clean-install journey on a disposable stack: builds the real server and web
# images, starts postgres + server + web, waits for health, then exercises the
# authenticated API through the shipped web proxy (nginx) exactly as a user
# would. Removes every container, network, and volume it creates.

scope=agenticform-clean-install-$$
port=${AGENTICFORM_JOURNEY_PORT:-18080}
admin_token=journey-admin-token-0123456789abcdef
secret_key=journey-separate-encryption-key-32chars
project_root=$(mktemp -d)

cleanup() {
  if [ "${AGENTICFORM_JOURNEY_KEEP:-0}" = "1" ]; then
    echo "keeping stack: web=$scope-web server=$scope-server postgres=$scope-postgres port=$port"
    return
  fi
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
  -e AGENTICFORM_VERSION=clean-install-journey \
  -v "$project_root:/srv/apps" -v "$scope-worktrees:/srv/agenticform/worktrees" \
  "$scope-server" >/dev/null
docker run -d --name "$scope-web" --network "$scope" --network-alias web \
  -p "127.0.0.1:$port:8080" "$scope-web" >/dev/null

echo '== wait for public health =='
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q UP; then break; fi
  sleep 3
done
curl -fsS "http://127.0.0.1:$port/actuator/health" | grep -q UP

api=http://127.0.0.1:$port/api
auth="Authorization: Bearer $admin_token"

echo '== unauthenticated requests must be rejected =='
code=$(curl -s -o /dev/null -w '%{http_code}' "$api/projects")
test "$code" = 401

echo '== authenticated snapshot loads through the proxy =='
curl -fsS -H "$auth" "$api/projects" | grep -q '\['
curl -fsS -H "$auth" "$api/agents" | grep -q '\['
curl -fsS -H "$auth" "$api/tasks" | grep -q '\['

echo '== register a project and confirm it persists =='
response=$(curl -sS -H "$auth" -H 'Content-Type: application/json' -X POST "$api/projects" \
  -d '{"name":"clean-install","sourceType":"LOCAL_PATH","path":"/srv/apps","defaultBranch":"main"}')
echo "$response" | grep -q 'clean-install' || { echo "project registration failed: $response"; exit 1; }
curl -fsS -H "$auth" "$api/projects" | grep -q 'clean-install'

echo '== restart server and confirm durable state survives =='
docker restart "$scope-server" >/dev/null
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q UP; then break; fi
  sleep 3
done
curl -fsS -H "$auth" "$api/projects" | grep -q 'clean-install'

echo 'CLEAN INSTALL JOURNEY VERIFIED'
