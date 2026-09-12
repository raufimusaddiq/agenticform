ALTER TABLE agents
    ADD COLUMN runtime_generation BIGINT NOT NULL DEFAULT 0;

UPDATE agents
SET runtime_generation = 1
WHERE execution_node_id IS NOT NULL;

ALTER TABLE node_commands
    ADD COLUMN runtime_generation BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

UPDATE node_commands command
SET runtime_generation = agent.runtime_generation
FROM agents agent
WHERE command.agent_id = agent.id;

ALTER TABLE human_approvals
    ADD COLUMN remote_interaction_id UUID;

CREATE UNIQUE INDEX ux_human_approvals_remote_interaction
    ON human_approvals(remote_interaction_id)
    WHERE remote_interaction_id IS NOT NULL;

CREATE TABLE remote_codex_interactions (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    runtime_generation BIGINT NOT NULL,
    codex_request_id VARCHAR(255) NOT NULL,
    method VARCHAR(255) NOT NULL,
    params_json TEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    response_json TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    CONSTRAINT uq_remote_codex_request UNIQUE (node_id, agent_id, runtime_generation, codex_request_id)
);
CREATE INDEX idx_remote_codex_interactions_status ON remote_codex_interactions(status, created_at);
CREATE INDEX idx_remote_codex_interactions_agent ON remote_codex_interactions(agent_id, runtime_generation);

CREATE TABLE node_runtime_snapshots (
    id UUID PRIMARY KEY,
    node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    runtime_generation BIGINT NOT NULL,
    thread_id VARCHAR(255),
    source_directory TEXT,
    working_directory TEXT,
    branch VARCHAR(255),
    runtime_status VARCHAR(32) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_node_runtime_snapshot UNIQUE (node_id, agent_id)
);
CREATE INDEX idx_node_runtime_snapshots_agent_generation
    ON node_runtime_snapshots(agent_id, runtime_generation);
