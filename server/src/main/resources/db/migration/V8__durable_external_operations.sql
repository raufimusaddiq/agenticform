CREATE TABLE operation_external_waits (
    id UUID PRIMARY KEY,
    operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
    step_run_id UUID NOT NULL REFERENCES operation_step_runs(id) ON DELETE CASCADE,
    provider VARCHAR(32) NOT NULL,
    mode VARCHAR(16) NOT NULL,
    repository VARCHAR(255) NOT NULL,
    workflow VARCHAR(255) NOT NULL,
    ref VARCHAR(255) NOT NULL,
    expected_head_sha VARCHAR(64) NOT NULL,
    external_run_id BIGINT,
    external_url TEXT,
    correlation_not_before TIMESTAMPTZ,
    deadline TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL,
    last_observed_status VARCHAR(32),
    last_observed_conclusion VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operation_external_wait_step UNIQUE (step_run_id)
);

CREATE INDEX idx_operation_external_waits_status
    ON operation_external_waits(status, deadline);
CREATE INDEX idx_operation_external_waits_external_run
    ON operation_external_waits(provider, external_run_id);
CREATE INDEX idx_operation_external_waits_correlation
    ON operation_external_waits(provider, repository, workflow, ref, expected_head_sha);

CREATE TABLE github_webhook_deliveries (
    delivery_id VARCHAR(128) PRIMARY KEY,
    event VARCHAR(64) NOT NULL,
    payload_sha256 VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE operation_events (
    id UUID PRIMARY KEY,
    operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    target_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    event_type VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    codex_queued_submission_id VARCHAR(255),
    codex_turn_id VARCHAR(255),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operation_event UNIQUE (operation_run_id, event_type)
);

CREATE INDEX idx_operation_events_delivery
    ON operation_events(status, created_at);
