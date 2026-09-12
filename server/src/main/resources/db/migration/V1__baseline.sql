CREATE TABLE projects (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    root_directory TEXT NOT NULL UNIQUE,
    default_branch VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE agents (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    name VARCHAR(255) NOT NULL,
    responsibility TEXT NOT NULL,
    workspace_mode VARCHAR(64) NOT NULL,
    source_directory TEXT NOT NULL,
    working_directory TEXT NOT NULL,
    branch VARCHAR(255),
    status VARCHAR(64) NOT NULL,
    queue_mode VARCHAR(64) NOT NULL,
    active_task_id UUID,
    active_turn_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_agents_project_id ON agents(project_id);
CREATE INDEX idx_agents_status ON agents(status);

CREATE TABLE tasks (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id),
    assigned_agent_id UUID NOT NULL REFERENCES agents(id),
    title VARCHAR(255) NOT NULL,
    prompt TEXT NOT NULL,
    status VARCHAR(64) NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    codex_queued_submission_id VARCHAR(255),
    codex_turn_id VARCHAR(255),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_tasks_agent_status ON tasks(assigned_agent_id, status);
CREATE INDEX idx_tasks_codex_turn_id ON tasks(codex_turn_id);
