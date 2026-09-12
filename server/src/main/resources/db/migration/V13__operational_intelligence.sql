CREATE TABLE operational_signals (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source VARCHAR(64) NOT NULL,
    signal_type VARCHAR(128) NOT NULL,
    severity VARCHAR(32) NOT NULL,
    fingerprint VARCHAR(255) NOT NULL,
    correlation_key VARCHAR(255),
    payload_json TEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_operational_signals_project_status_last_seen
    ON operational_signals(project_id, status, last_seen_at DESC);
CREATE INDEX idx_operational_signals_fingerprint
    ON operational_signals(project_id, fingerprint, last_seen_at DESC);

CREATE TABLE operational_incidents (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    incident_type VARCHAR(128) NOT NULL,
    severity VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    fingerprint VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT NOT NULL,
    suspected_change VARCHAR(255),
    operational_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    wake_status VARCHAR(32) NOT NULL,
    wake_attempts INTEGER NOT NULL DEFAULT 0,
    wake_command_id UUID REFERENCES node_commands(id) ON DELETE SET NULL,
    codex_queued_submission_id VARCHAR(255),
    codex_turn_id VARCHAR(255),
    last_wake_error TEXT,
    resolution_summary TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_operational_incidents_project_status
    ON operational_incidents(project_id, status, updated_at DESC);
CREATE INDEX idx_operational_incidents_fingerprint
    ON operational_incidents(project_id, fingerprint, updated_at DESC);
CREATE INDEX idx_operational_incidents_wake
    ON operational_incidents(wake_status, updated_at ASC);

CREATE TABLE operational_incident_signals (
    incident_id UUID NOT NULL REFERENCES operational_incidents(id) ON DELETE CASCADE,
    signal_id UUID NOT NULL REFERENCES operational_signals(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (incident_id, signal_id)
);
CREATE INDEX idx_operational_incident_signals_signal
    ON operational_incident_signals(signal_id);
