#!/bin/sh
set -eu

# Run from the repository root with an image built from web/Dockerfile.
test -f server/pom.xml
image=${1:?usage: sh tests/stream-proxy.sh WEB_IMAGE}
scope=agenticform-stream-test-$$
cleanup() {
  docker rm -f "$scope-proxy" "$scope-server" >/dev/null 2>&1 || true
  docker network rm "$scope" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker network create "$scope" >/dev/null
docker run -d --name "$scope-server" --network "$scope" --network-alias server \
  -e STREAM_TEST_PROXY_URL=http://proxy:8080 \
  -v "$(pwd)/server:/source:ro" \
  -v agenticform-audit-maven-cache:/root/.m2 \
  maven:3.9-eclipse-temurin-21 sh -c \
  'cp -a /source /tmp/server && cd /tmp/server && mvn -B -ntp -Dtest=StreamSecurityIntegrationTest test' >/dev/null
docker run -d --name "$scope-proxy" --network "$scope" --network-alias proxy "$image" >/dev/null
result=$(docker wait "$scope-server")
docker logs "$scope-server"
docker logs "$scope-proxy"
test "$result" = 0
