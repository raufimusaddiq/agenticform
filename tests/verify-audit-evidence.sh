#!/bin/sh
set -eu

# Re-runs the local, source-level evidence for the PR #33 repair plan and prints
# a pass/fail summary. The heavier end-to-end journeys (clean install, browser,
# node loss, restore) are separate scripts and run as CI jobs; run them too for
# full coverage. Requires Docker; uses only disposable containers/databases.

failures=0

step() {
  name=$1
  shift
  printf '== %s ==\n' "$name"
  if "$@"; then
    printf 'PASS: %s\n\n' "$name"
  else
    printf 'FAIL: %s\n\n' "$name"
    failures=$((failures + 1))
  fi
}

server_tests() {
  scope=agenticform-evidence-$$
  docker run -d --name "$scope-db" -p 127.0.0.1:55495:5432 \
    -e POSTGRES_DB=evidence_db -e POSTGRES_USER=evidence -e POSTGRES_PASSWORD=evidence-disposable \
    postgres:17-alpine >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$scope-db" pg_isready -U evidence -d evidence_db >/dev/null 2>&1 && break
    sleep 2
  done
  docker run --rm --network host -v "$(pwd)/server:/source:ro" -v agenticform-audit-maven-cache:/root/.m2 \
    -e MIGRATION_TEST_DATABASE_URL=jdbc:postgresql://127.0.0.1:55495/evidence_db \
    -e MIGRATION_TEST_DATABASE_USER=evidence -e MIGRATION_TEST_DATABASE_PASSWORD=evidence-disposable \
    maven:3.9-eclipse-temurin-21 sh -c 'cp -a /source /tmp/server && cd /tmp/server && mvn -B -ntp test'
  rc=$?
  docker rm -f "$scope-db" >/dev/null 2>&1 || true
  return $rc
}

node_checks() {
  docker run --rm --network host -v "$(pwd)/node:/src:ro" golang:1.24-bookworm \
    sh -c 'cp -a /src /tmp/n && cd /tmp/n && go test ./... && go vet ./...'
}

web_checks() {
  docker run --rm --network host -v "$(pwd)/web:/source:ro" node:24-alpine \
    sh -c 'mkdir /tmp/c && cp /source/package*.json /source/index.html /source/tsconfig*.json /source/vite.config.ts /tmp/c/ && cp -a /source/src /source/tests /tmp/c/ && cd /tmp/c && npm ci --no-audit --no-fund && npm test && npm run build'
}

step 'server tests + Flyway migrations (disposable database)' server_tests
step 'node go test + go vet' node_checks
step 'web npm ci + test + build' web_checks

printf '\n'
if [ "$failures" -eq 0 ]; then
  echo 'AUDIT EVIDENCE VERIFIED (source-level). Run the journey scripts for end-to-end proof.'
else
  echo "AUDIT EVIDENCE FAILED: $failures step(s)"
  exit 1
fi
