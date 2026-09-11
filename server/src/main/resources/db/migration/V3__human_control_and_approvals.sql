ALTER TABLE agents
    ADD COLUMN human_control_mode VARCHAR(64) NOT NULL DEFAULT 'IN_THE_LOOP';

CREATE TABLE human_approvals (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    codex_request_id VARCHAR(255) NOT NULL,
    method VARCHAR(255) NOT NULL,
    type VARCHAR(64) NOT NULL,
    control_mode VARCHAR(64) NOT NULL,
    risk VARCHAR(64) NOT NULL,
    status VARCHAR(64) NOT NULL,
    thread_id VARCHAR(255) NOT NULL,
    turn_id VARCHAR(255),
    item_id VARCHAR(255),
    summary TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    response_payload TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_human_approvals_project_created
    ON human_approvals(project_id, created_at DESC);
CREATE INDEX idx_human_approvals_agent_status
    ON human_approvals(agent_id, status);
CREATE INDEX idx_human_approvals_status_created
    ON human_approvals(status, created_at DESC);
