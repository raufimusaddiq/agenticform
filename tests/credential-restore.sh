#!/bin/sh
set -eu

# Proves encrypted credentials and durable state survive a real pg_dump/restore.
# Requires a Docker daemon. Uses two throwaway databases and removes them after.
# Usage: sh tests/credential-restore.sh

scope=agenticform-restore-test-$$
source_db="$scope-source"
target_db="$scope-target"
port=55490
dump_dir=$(mktemp -d)
cache_volume=agenticform-audit-maven-cache

cleanup() {
  docker rm -f "$scope-pg" >/dev/null 2>&1 || true
  docker network rm "$scope" >/dev/null 2>&1 || true
  rm -rf "$dump_dir"
}
trap cleanup EXIT INT TERM

docker network create "$scope" >/dev/null
docker run -d --name "$scope-pg" --network "$scope" --network-alias pg \
  -e POSTGRES_DB="$source_db" -e POSTGRES_USER=restore -e POSTGRES_PASSWORD=restore-disposable \
  postgres:17-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$scope-pg" pg_isready -U restore -d "$source_db" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$scope-pg" pg_isready -U restore -d "$source_db" >/dev/null

mvn_test() {
  db=$1
  mode=$2
  docker run --rm --network "$scope" -v "$(pwd)/server:/source:ro" -v "$cache_volume:/root/.m2" \
    -e MIGRATION_TEST_DATABASE_URL="jdbc:postgresql://pg:5432/$db" \
    -e MIGRATION_TEST_DATABASE_USER=restore -e MIGRATION_TEST_DATABASE_PASSWORD=restore-disposable \
    -e RESTORE_TEST_MODE="$mode" \
    maven:3.9-eclipse-temurin-21 sh -c 'cp -a /source /tmp/server && cd /tmp/server && mvn -B -ntp -Dtest=CredentialRestoreTest test'
}

echo '== seed source database =='
mvn_test "$source_db" seed

echo '== logical backup =='
docker exec "$scope-pg" pg_dump -U restore -d "$source_db" -Fc -f /tmp/agenticform-backup.dump
docker exec "$scope-pg" createdb -U restore "$target_db"
docker exec "$scope-pg" pg_restore -U restore -d "$target_db" /tmp/agenticform-backup.dump

echo '== verify restored database independently =='
mvn_test "$target_db" verify

echo 'RESTORE VERIFIED'
