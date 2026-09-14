# Distributed Agent Fabric

Sprint 11 turns Agenticform into a control plane that can place Codex agents on enrolled execution nodes while keeping policy, durable state, operations, approvals, and inter-agent routing centralized.

## Security model

Execution nodes are outbound-only workers. A node does not expose Codex, SSH, or an Agenticform worker port to the control plane.

```text
Browser/operator -- Bearer admin token --> Agenticform control plane
GitHub          -- webhook HMAC -------> Agenticform control plane
Execution node  -- Ed25519 signed HTTPS -> Agenticform control plane
                                             |
                                             +-- PostgreSQL durable state
```

The control plane is authoritative for projects, logical agents, tasks, communication, policy, approvals, operational runbooks, node placement, and node revocation. A node owns only its local execution runtime, local workspaces, and its private device key.

### Control-plane authentication

All human/operator APIs require:

```text
Authorization: Bearer <AGENTICFORM_ADMIN_TOKEN>
```

The current Sprint 11 implementation is intentionally a **single-admin bootstrap authentication model**, not multi-user OIDC/RBAC. `AGENTICFORM_ADMIN_TOKEN` is required for local and remote control planes and must be at least 32 characters. The web UI keeps the token in `sessionStorage`; it is not persisted to `localStorage`.

For any non-loopback deployment:

- `AGENTICFORM_PUBLIC_URL` must use HTTPS;
- `AGENTICFORM_NODE_IMAGE` must be digest-qualified (`image@sha256:<64 hex>`).

`AGENTICFORM_PUBLIC_URL` must be a clean origin without URL credentials, path, query string, or fragment. The server fails closed at startup when these requirements are not met. Remote TLS cannot be disabled by configuration.

The HTTP security layer is stateless, denies framing, disables form/basic login, sends no-referrer/content-type protections, and enables HSTS for HTTPS deployments. Only `/actuator/health` is public from Actuator.

The only unauthenticated HTTP surfaces are intentionally separate machine/bootstrap protocols:

- actuator health;
- GitHub webhook endpoint, authenticated by its HMAC secret;
- node enrollment endpoint, authenticated by a one-time enrollment token;
- node runtime endpoints, authenticated by the enrolled node Ed25519 identity.

Authentication failures exposed by machine endpoints return generic responses so node existence/signature details are not disclosed to callers.

### Node enrollment

From the UI choose **Execution nodes → Add execution node**. Agenticform creates a 256-bit enrollment token with a short TTL (10 minutes by default) and stores only its SHA-256 hash.

The generated command uses an ephemeral enrollment container:

1. require the setup command to be run as a non-root host user;
2. generate separate Ed25519 signing and RSA encryption key pairs on the node;
3. send only the validated public keys plus the one-time token to Agenticform;
4. atomically consume the enrollment token under a database row lock;
5. persist the private key only in `$HOME/.agenticform-node` with mode `0600`;
6. discard the enrollment container and token;
7. start the permanent daemon without the enrollment token.

Reusing, racing, or using an expired enrollment token is rejected. Revoking a node is terminal for that device identity; it must enroll again with a new key pair.

The bootstrap token can appear in the one-time shell command/history, but it becomes invalid as soon as enrollment succeeds and otherwise expires after its short TTL. It is never retained by the permanent node daemon.

### Signed node protocol and replay protection

Every post-enrollment node request includes:

```text
X-AF-Timestamp
X-AF-Nonce
X-AF-Signature
```

The Ed25519 signature covers:

```text
nodeId
unixTimestampMs
nonce
HTTP method
HTTP path
SHA-256(request body)
```

The server validates clock skew, node status, signature, and a durable `(node_id, nonce)` unique constraint. A captured request therefore cannot be replayed inside the timestamp window. Invalid signatures do not consume nonce rows. Expired nonce records are removed by scheduled cleanup.

Remote Codex server requests also validate that the supplied Codex thread belongs to an agent bound to the authenticated execution node, preventing one enrolled node from impersonating another node's thread. Remote task lifecycle notifications are subject to the same node/agent ownership check.

### Runtime isolation

The node image defines a non-root user by default. The generated permanent Docker invocation additionally runs as the invoking host UID/GID with:

```text
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt no-new-privileges:true
--cap-drop ALL
```

The unconfined profile options are required because the node uses bubblewrap (`bwrap`) for the
inner Codex sandbox. The node remains non-root, drops all capabilities, enables
`no-new-privileges`, and does not mount the Docker socket or host root filesystem. The generated
command applies these options to both the one-shot enrollment container and permanent daemon.

It does not mount the Docker socket, host root filesystem, or publish inbound ports. It receives only:

- `$HOME/.agenticform-node` for node identity, repository cache, worktrees, and runtime state;
- `$HOME/.codex` as the node-local Codex account/configuration source.

Codex App Server runs locally over stdio. Agenticform does not expose a Codex App Server port on the network.

A compromised execution node may expose that node's local workspaces, node device identity, and node-local Codex authentication. It must not automatically provide:

- Agenticform administrator authority;
- identities of other execution nodes;
- production deployment credentials;
- authority to increase its own trust level;
- the ability to bypass deterministic policy or registered operational runbooks.

Production credentials should remain in GitHub Environments, the operational executor, or another purpose-built secret provider rather than on coding nodes.

## Immutable node image

The release workflow publishes:

```text
ghcr.io/raufimusaddiq/agenticform-node:sha-<git commit>
```

and reports the pushed OCI digest. Configure a public/non-local Agenticform deployment with the digest-qualified value:

```bash
AGENTICFORM_NODE_IMAGE=ghcr.io/raufimusaddiq/agenticform-node@sha256:<digest>
```

Mutable tags such as `latest` are allowed only for local development. A non-local control plane refuses to start with a mutable node image reference.

## Node placement

Execution nodes heartbeat capacity and observed runtime capabilities. These are scheduling availability signals, not authorization claims. Trust level is assigned by the operator during enrollment and is not accepted from heartbeat data.

The capability payload uses a runtime-neutral inventory:

```json
{
  "git": true,
  "runtimes": {
    "CODEX": {
      "available": true,
      "authenticated": true,
      "version": "0.154.0"
    }
  }
}
```

Placement requests use requirements such as `runtime:CODEX`. Runtime observations and commands require an explicit `runtimeType` and `runtimeSessionId`; unsupported runtime types are rejected at the node command boundary.

The scheduler considers:

- node status;
- minimum operator-controlled trust level;
- required capabilities;
- `maxAgents` capacity;
- active agent load;
- optional explicitly preferred node.

GIT-backed projects can run on remote nodes. `LOCAL_PATH` projects remain bound to the local control-plane host.

Repository URLs are metadata, not credentials. GIT project registration accepts credential-free HTTPS URLs only; userinfo, query-string tokens, fragments, SSH URLs, and plaintext HTTP are rejected. Private-repository credential brokerage is deliberately not implemented by storing a PAT in project metadata or node commands; use public repositories or node-local supported credentials for this MVP until a scoped short-lived credential provider is added.

## Remote Codex runtime

A node materializes the repository and workspace locally, then starts:

```text
codex app-server --stdio
```

The control plane sends durable semantic node commands rather than arbitrary host shell commands:

- `START_AGENT`
- `DISPATCH_TASK`
- `DELIVER_MESSAGE`
- `INTERRUPT_TURN`

Dynamic Agenticform tools and Codex approval requests are proxied back to the control plane. Policy and approval logic therefore remain centralized even when the Codex thread lives on another machine.

## Agent communication fabric

Agenticform communication supports:

- `DIRECT`
- `MULTICAST`
- `ROLE`
- `GROUP`
- `PROJECT_BROADCAST`

A fanout is represented as one logical message plus one durable delivery per resolved recipient. Recipients are resolved and snapshotted at send time, making audit/retry deterministic even if project membership changes later.

Broadcasts are same-project, have a bounded fanout, exclude the sender by default, and do not imply reply-all. Direct replies remain the default to prevent recursive agent-swarm amplification.

## Required configuration

At minimum, including local development:

```bash
AGENTICFORM_ADMIN_TOKEN=<random value at least 32 characters>
```

For a remote deployment:

```bash
AGENTICFORM_PUBLIC_URL=https://agenticform.example.com
AGENTICFORM_ADMIN_TOKEN=<random value at least 32 characters>
AGENTICFORM_NODE_IMAGE=ghcr.io/raufimusaddiq/agenticform-node@sha256:<digest>
AGENTICFORM_GITHUB_WEBHOOK_SECRET=<random webhook secret>
```

The reverse proxy must terminate valid TLS, must not expose the backend on an unintended public interface, and should restrict the UI origin configuration to the actual Agenticform web origin.

## Revocation semantics

- **Drain**: stop receiving new placement while existing work can finish.
- **Disable**: reject signed runtime requests until explicitly re-enabled.
- **Revoke**: permanently invalidate the enrolled device identity. Re-enrollment with a new key pair is required.

Node loss never grants another node the dead node's private identity. Logical work remains durable in PostgreSQL; replacement/re-hydration is a separate recovery action rather than silent live migration of a Codex thread.

## Current security scope

Sprint 11 deliberately does not claim enterprise multi-user identity. The current admin Bearer token is appropriate for a single-owner/self-hosted control plane when transported only over TLS and stored as a strong secret. A later identity sprint can replace this bootstrap layer with OIDC/passkeys, named users, granular RBAC, and audit actors without weakening the execution-node device protocol.
