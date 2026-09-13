FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY node/go.mod ./go.mod
COPY node/cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/agenticform-node ./cmd/agenticform-node

FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.154.0
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git bubblewrap \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && groupadd --gid 10001 agenticform \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin agenticform \
    && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /out/agenticform-node /usr/local/bin/agenticform-node
RUN mkdir -p /var/lib/agenticform-node \
    && chown 10001:10001 /var/lib/agenticform-node \
    && chmod 0700 /var/lib/agenticform-node
WORKDIR /var/lib/agenticform-node
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/agenticform-node"]
CMD ["daemon"]
