CREATE TABLE execution_nodes (
    id UUID PRIMARY KEY,
    name VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(32) NOT NULL,
    trust_level VARCHAR(32) NOT NULL,
    public_key_base64 TEXT NOT NULL,
    fingerprint VARCHAR(128) NOT NULL UNIQUE,
    labels_json TEXT NOT NULL DEFAULT '{}',
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    max_agents INTEGER NOT NULL DEFAULT 1,
    os VARCHAR(64),
    arch VARCHAR(64),
    hostname VARCHAR(255),
    node_version VARCHAR(64),
    codex_version VARCHAR(64),
    cpu_cores INTEGER,
    memory_mb BIGINT,
    disk_free_mb BIGINT,
    enrolled_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_execution_nodes_status ON execution_nodes(status);
CREATE INDEX idx_execution_nodes_last_seen ON execution_nodes(last_seen_at);

CREATE TABLE node_enrollment_tokens (
    id UUID PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    requested_name VARCHAR(128) NOT NULL,
    requested_trust_level VARCHAR(32) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_node_enrollment_tokens_expires ON node_enrollment_tokens(expires_at);

CREATE TABLE node_commands (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    command_type VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    lease_until TIMESTAMPTZ,
    result_json TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    leased_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX idx_node_commands_node_status ON node_commands(node_id, status, created_at);

ALTER TABLE projects
    ADD COLUMN source_type VARCHAR(32) NOT NULL DEFAULT 'LOCAL_PATH',
    ADD COLUMN repository_url TEXT;
ALTER TABLE projects ALTER COLUMN root_directory DROP NOT NULL;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_root_directory_key;
CREATE UNIQUE INDEX ux_projects_root_directory_not_null ON projects(root_directory) WHERE root_directory IS NOT NULL;
CREATE UNIQUE INDEX ux_projects_repository_url_not_null ON projects(repository_url) WHERE repository_url IS NOT NULL;

ALTER TABLE agents
    ADD COLUMN execution_node_id UUID REFERENCES execution_nodes(id) ON DELETE SET NULL;
ALTER TABLE agents ALTER COLUMN source_directory DROP NOT NULL;
ALTER TABLE agents ALTER COLUMN working_directory DROP NOT NULL;
CREATE INDEX idx_agents_execution_node ON agents(execution_node_id);

ALTER TABLE agent_messages
    ADD COLUMN audience_type VARCHAR(32) NOT NULL DEFAULT 'DIRECT',
    ADD COLUMN audience_spec_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agent_messages ALTER COLUMN to_agent_id DROP NOT NULL;

CREATE TABLE agent_message_deliveries (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
    to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    codex_queued_submission_id VARCHAR(255),
    codex_turn_id VARCHAR(255),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_agent_message_delivery UNIQUE (message_id, to_agent_id)
);
CREATE INDEX idx_message_deliveries_agent_status ON agent_message_deliveries(to_agent_id, status);

INSERT INTO agent_message_deliveries (
    id, message_id, to_agent_id, status, attempt_count,
    codex_queued_submission_id, codex_turn_id, last_error, created_at, updated_at
)
SELECT gen_random_uuid(), id, to_agent_id, status, 1,
       codex_queued_submission_id, codex_turn_id, last_error, created_at, updated_at
FROM agent_messages
WHERE to_agent_id IS NOT NULL;

CREATE TABLE agent_groups (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_agent_group_name UNIQUE (project_id, name)
);

CREATE TABLE agent_group_memberships (
    group_id UUID NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (group_id, agent_id)
);
