CREATE TABLE operational_environments (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operational_environment UNIQUE (project_id, key)
);

CREATE TABLE operational_services (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES operational_environments(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    health_url TEXT,
    readiness_url TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operational_service UNIQUE (environment_id, key)
);

CREATE TABLE operational_runbooks (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES operational_environments(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    description TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1,
    definition_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operational_runbook UNIQUE (project_id, key)
);

CREATE TABLE operation_runs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    runbook_id UUID NOT NULL REFERENCES operational_runbooks(id),
    environment_id UUID NOT NULL REFERENCES operational_environments(id),
    requested_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    requested_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    requested_by VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    environment_key VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    policy_effect VARCHAR(32) NOT NULL,
    policy_rule_id UUID REFERENCES policy_rules(id) ON DELETE SET NULL,
    runbook_snapshot TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    approved_by VARCHAR(128),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_operation_runs_project_created ON operation_runs(project_id, created_at DESC);
CREATE INDEX idx_operation_runs_status ON operation_runs(status);
CREATE INDEX idx_operation_runs_runbook ON operation_runs(runbook_id, created_at DESC);

CREATE TABLE operation_step_runs (
    id UUID PRIMARY KEY,
    operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
    step_key VARCHAR(64) NOT NULL,
    step_name VARCHAR(128) NOT NULL,
    step_type VARCHAR(32) NOT NULL,
    position INTEGER NOT NULL,
    status VARCHAR(32) NOT NULL,
    summary TEXT,
    evidence TEXT,
    exit_code INTEGER,
    duration_ms BIGINT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_operation_step_runs_run ON operation_step_runs(operation_run_id, position);
