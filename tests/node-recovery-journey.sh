#!/bin/sh
set -eu

# Node-loss recovery journey on a disposable stack. Builds the real server image,
# starts postgres + server, enrolls a real Go node daemon, then kills the daemon
# and verifies the control plane marks the node OFFLINE and correlates an
# EXECUTION_NODE_LOST incident. Everything created here is removed afterwards.
# The daemon runs with host networking because it only accepts HTTPS for
# non-loopback servers (loopback is the documented local exception).

scope=agenticform-node-loss-$$
port=18098
admin_token=journey-admin-token-0123456789abcdef
secret_key=journey-separate-encryption-key-32chars
project_root=$(mktemp -d)
node_state=$(mktemp -d)

cleanup() {
  docker rm -f "$scope-node-daemon" "$scope-server" "$scope-postgres" >/dev/null 2>&1 || true
  docker network rm "$scope" >/dev/null 2>&1 || true
  docker volume rm "$scope-db" "$scope-worktrees" >/dev/null 2>&1 || true
  rm -rf "$project_root" "$node_state"
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAILED: $1"
  echo '--- server log ---'
  docker logs --tail 40 "$scope-server" 2>&1 || true
  echo '--- node log ---'
  docker logs --tail 40 "$scope-node-daemon" 2>&1 || true
  exit 1
}

echo '== build server image =='
docker build -q --network host -t "$scope-server" -f server/Dockerfile . >/dev/null

echo '== start postgres + server =='
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

docker run -d --name "$scope-server" --network "$scope" --network-alias server \
  -p "127.0.0.1:$port:8080" \
  -e DATABASE_URL=jdbc:postgresql://postgres:5432/agenticform \
  -e DATABASE_USER=agenticform -e DATABASE_PASSWORD=agenticform-disposable \
  -e AGENTICFORM_ADMIN_TOKEN="$admin_token" -e AGENTICFORM_SECRET_KEY="$secret_key" \
  -e AGENTICFORM_PUBLIC_URL="http://127.0.0.1:$port" \
  -e AGENTICFORM_UI_ORIGIN="http://127.0.0.1:$port" \
  -e AGENTICFORM_PROJECT_ROOT=/srv/apps \
  -e AGENTICFORM_NODE_OFFLINE_AFTER=20s \
  -e AGENTICFORM_NODE_HEALTH_DELAY_MS=5000 \
  -e AGENTICFORM_NODE_RECOVERY_DELAY_MS=5000 \
  -v "$project_root:/srv/apps" -v "$scope-worktrees:/srv/agenticform/worktrees" \
  "$scope-server" >/dev/null

api="http://127.0.0.1:$port/api"
auth="Authorization: Bearer $admin_token"

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q UP; then break; fi
  sleep 3
done
curl -fsS "http://127.0.0.1:$port/actuator/health" | grep -q UP || fail 'server did not become healthy'

echo '== enroll node =='
token=$(curl -fsS -H "$auth" -H 'Content-Type: application/json' \
  -X POST "$api/nodes/enrollments" -d '{"name":"journey-node","trustLevel":"STANDARD"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') || fail 'enrollment request failed'
test -n "$token" || fail 'no enrollment token returned'

node_image=golang:1.24-bookworm
node_build='cp -a /src/node /tmp/n && cd /tmp/n && go build -o /tmp/daemon ./cmd/agenticform-node && '

docker run --rm --network host \
  -e AGENTICFORM_SERVER="http://127.0.0.1:$port" \
  -e AGENTICFORM_ENROLLMENT_TOKEN="$token" \
  -e AGENTICFORM_NODE_STATE=/state \
  -v "$(pwd)/node:/src/node:ro" -v "$node_state:/state" \
  "$node_image" sh -c "$node_build /tmp/daemon enroll" >/dev/null || fail 'node enrollment failed'

echo '== start node daemon =='
docker run -d --name "$scope-node-daemon" --network host \
  -e AGENTICFORM_SERVER="http://127.0.0.1:$port" \
  -e AGENTICFORM_NODE_STATE=/state \
  -v "$(pwd)/node:/src/node:ro" -v "$node_state:/state" \
  "$node_image" sh -c "$node_build /tmp/daemon daemon" >/dev/null

online=0
for _ in $(seq 1 60); do
  if curl -fsS -H "$auth" "$api/nodes" 2>/dev/null | grep -q '"ONLINE"'; then online=1; break; fi
  sleep 3
done
test "$online" = 1 || fail 'node never reported ONLINE'
echo 'node ONLINE'

node_id=$(curl -fsS -H "$auth" "$api/nodes" \
  | python3 -c 'import json,sys; print([n["id"] for n in json.load(sys.stdin) if n["status"]=="ONLINE"][0])')
test -n "$node_id" || fail 'could not resolve the online node id'

# Bind a project + agent to the node so node loss has an active-agent impact and
# therefore a correlated incident (EXECUTION_NODE_LOST). Seeded directly into the
# disposable database to avoid depending on a live Codex runtime here.
project_id=$(python3 -c 'import uuid;print(uuid.uuid4())')
agent_id=$(python3 -c 'import uuid;print(uuid.uuid4())')
docker exec "$scope-postgres" psql -U agenticform -d agenticform -v ON_ERROR_STOP=1 -q -c "
INSERT INTO projects (id, name, slug, root_directory, source_type, default_branch, enabled, created_at, updated_at)
VALUES ('$project_id', 'Node Loss Fixture', 'node-loss-fixture', NULL, 'GIT', 'main', TRUE, NOW(), NOW());
INSERT INTO agents (id, project_id, name, responsibility, runtime_type, workspace_mode, status, queue_mode,
  human_control_mode, agent_role, system_managed, capability_profile, execution_node_id, runtime_generation, created_at, updated_at)
VALUES ('$agent_id', '$project_id', 'Fixture Agent', 'fixture', 'CODEX', 'ISOLATED_WORKTREE', 'WORKING', 'AUTO',
  'ON_THE_LOOP', 'GENERAL', FALSE, 'IMPLEMENTER', '$node_id', 1, NOW(), NOW());" >/dev/null   || fail 'failed to seed project/agent fixture'
echo 'seeded project + agent bound to node'

sleep 5

# Sanity: the agent must be visible and marked as belonging to the node.
curl -fsS -H "$auth" "$api/agents?projectId=$project_id" | grep -q 'Fixture Agent' || fail 'seeded agent not visible'

echo '== kill node daemon =='
docker rm -f "$scope-node-daemon" >/dev/null

offline=0
for _ in $(seq 1 80); do
  if curl -fsS -H "$auth" "$api/nodes" 2>/dev/null | grep -q '"OFFLINE"'; then offline=1; break; fi
  sleep 3
done
test "$offline" = 1 || fail 'node was not marked OFFLINE after loss'
echo 'node OFFLINE'

signal=0
for _ in $(seq 1 60); do
  if curl -fsS -H "$auth" "$api/operational-intelligence/signals?projectId=$project_id" 2>/dev/null \
      | grep -q 'EXECUTION_NODE_OFFLINE_ACTIVE'; then signal=1; break; fi
  sleep 3
done
test "$signal" = 1 || fail 'EXECUTION_NODE_OFFLINE_ACTIVE signal was not recorded for a node with active agents'
echo 'EXECUTION_NODE_OFFLINE_ACTIVE signal recorded'

incident=0
for _ in $(seq 1 60); do
  if curl -fsS -H "$auth" "$api/operational-intelligence/incidents?projectId=$project_id" 2>/dev/null \
      | grep -q 'EXECUTION_NODE_LOST'; then incident=1; break; fi
  sleep 3
done
test "$incident" = 1 || fail 'EXECUTION_NODE_LOST incident was not correlated'
echo 'EXECUTION_NODE_LOST incident correlated'

# Bound agent must be marked DISCONNECTED, not left claiming to work.
curl -fsS -H "$auth" "$api/agents?projectId=$project_id" | grep -q 'DISCONNECTED' \
  || fail 'agent on the lost node was not marked DISCONNECTED'
echo 'agent on lost node marked DISCONNECTED'

echo 'NODE LOSS JOURNEY VERIFIED'
