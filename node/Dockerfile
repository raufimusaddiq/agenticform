FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY node/go.mod ./go.mod
COPY node/cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/agenticform-node ./cmd/agenticform-node

FROM node:22-bookworm-slim
ARG CODEX_VERSION=0.154.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /out/agenticform-node /usr/local/bin/agenticform-node
RUN mkdir -p /var/lib/agenticform-node && chmod 0700 /var/lib/agenticform-node
WORKDIR /var/lib/agenticform-node
ENTRYPOINT ["/usr/local/bin/agenticform-node"]
CMD ["daemon"]
