CREATE TABLE workspace_cleanup_records (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    working_directory TEXT NOT NULL,
    branch VARCHAR(255),
    outcome VARCHAR(32) NOT NULL,
    reason TEXT NOT NULL,
    freed_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_workspace_cleanup_project_created
    ON workspace_cleanup_records(project_id, created_at DESC);
