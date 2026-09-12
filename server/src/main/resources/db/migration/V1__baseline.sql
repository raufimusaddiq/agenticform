CREATE TABLE projects (
    id UUID PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    source_type VARCHAR(32) NOT NULL DEFAULT 'LOCAL_PATH',
    root_directory TEXT,
    repository_url TEXT,
    default_branch VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX ux_projects_root_directory_not_null ON projects(root_directory) WHERE root_directory IS NOT NULL;
CREATE UNIQUE INDEX ux_projects_repository_url_not_null ON projects(repository_url) WHERE repository_url IS NOT NULL;

CREATE TABLE policy_rules (
    id UUID PRIMARY KEY,
    scope_type VARCHAR(32) NOT NULL,
    scope_id UUID,
    action VARCHAR(128) NOT NULL,
    environment VARCHAR(64) NOT NULL DEFAULT '*',
    effect VARCHAR(32) NOT NULL,
    description TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT chk_policy_rule_scope CHECK ((scope_type = 'GLOBAL' AND scope_id IS NULL) OR (scope_type IN ('PROJECT', 'AGENT', 'TASK') AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_policy_rule_matcher ON policy_rules(scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), action, environment);
CREATE INDEX idx_policy_rules_enabled ON policy_rules(enabled);
CREATE INDEX idx_policy_rules_scope ON policy_rules(scope_type, scope_id);
INSERT INTO policy_rules(id, scope_type, scope_id, action, environment, effect, description, enabled, created_at, updated_at) VALUES
('00000000-0000-0000-0000-000000000001', 'GLOBAL', NULL, '*', '*', 'ALLOW', 'Default HOTL behavior: allow actions unless a more specific rule overrides it.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000002', 'GLOBAL', NULL, 'PRODUCTION_DEPLOY', 'production', 'REQUIRE_HUMAN', 'Production deploy/release requires fresh human approval.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000003', 'GLOBAL', NULL, 'PRODUCTION_DML', 'production', 'REQUIRE_HUMAN', 'Production data mutation requires fresh human approval.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000004', 'GLOBAL', NULL, 'DELETE_DATA', '*', 'REQUIRE_HUMAN', 'Deletion of persistent or business data requires fresh human approval.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000005', 'GLOBAL', NULL, 'USER_INPUT', '*', 'REQUIRE_HUMAN', 'Questions that genuinely require operator input are escalated to a human.', TRUE, NOW(), NOW());

CREATE TABLE execution_nodes (
    id UUID PRIMARY KEY, name VARCHAR(128) NOT NULL UNIQUE, status VARCHAR(32) NOT NULL, trust_level VARCHAR(32) NOT NULL,
    public_key_base64 TEXT NOT NULL, fingerprint VARCHAR(128) NOT NULL UNIQUE, labels_json TEXT NOT NULL DEFAULT '{}',
    capabilities_json TEXT NOT NULL DEFAULT '{}', max_agents INTEGER NOT NULL DEFAULT 1, os VARCHAR(64), arch VARCHAR(64),
    hostname VARCHAR(255), node_version VARCHAR(64), codex_version VARCHAR(64), cpu_cores INTEGER, memory_mb BIGINT,
    disk_free_mb BIGINT, drain_requested BOOLEAN NOT NULL DEFAULT FALSE, protocol_version INTEGER NOT NULL DEFAULT 1,
    enrolled_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_execution_nodes_status ON execution_nodes(status);
CREATE INDEX idx_execution_nodes_last_seen ON execution_nodes(last_seen_at);

CREATE TABLE agents (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), name VARCHAR(255) NOT NULL, responsibility TEXT NOT NULL,
    runtime_type VARCHAR(32) NOT NULL, runtime_session_id VARCHAR(255), workspace_mode VARCHAR(64) NOT NULL,
    source_directory TEXT, working_directory TEXT, branch VARCHAR(255), status VARCHAR(64) NOT NULL, queue_mode VARCHAR(64) NOT NULL,
    human_control_mode VARCHAR(64) NOT NULL DEFAULT 'ON_THE_LOOP', agent_role VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
    system_managed BOOLEAN NOT NULL DEFAULT FALSE, capability_profile VARCHAR(32) NOT NULL DEFAULT 'IMPLEMENTER',
    execution_node_id UUID REFERENCES execution_nodes(id) ON DELETE SET NULL, runtime_generation BIGINT NOT NULL DEFAULT 0,
    active_task_id UUID, active_turn_id VARCHAR(255), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_agents_project_id ON agents(project_id);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_execution_node ON agents(execution_node_id);
CREATE UNIQUE INDEX ux_agents_project_operational_role ON agents(project_id) WHERE agent_role = 'OPERATIONAL';
CREATE UNIQUE INDEX ux_agents_runtime_session ON agents(runtime_type, runtime_session_id) WHERE runtime_session_id IS NOT NULL;

CREATE TABLE tasks (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), assigned_agent_id UUID NOT NULL REFERENCES agents(id),
    title VARCHAR(255) NOT NULL, prompt TEXT NOT NULL, status VARCHAR(64) NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
    queued_submission_id VARCHAR(255), turn_id VARCHAR(255), last_error TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_tasks_project_id ON tasks(project_id);
CREATE INDEX idx_tasks_agent_status ON tasks(assigned_agent_id, status);
CREATE INDEX idx_tasks_turn_id ON tasks(turn_id);

CREATE TABLE agent_messages (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), from_agent_id UUID NOT NULL REFERENCES agents(id),
    to_agent_id UUID REFERENCES agents(id), conversation_id UUID NOT NULL, reply_to_message_id UUID REFERENCES agent_messages(id),
    type VARCHAR(64) NOT NULL, subject VARCHAR(255) NOT NULL, content TEXT NOT NULL, hop_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(64) NOT NULL, audience_type VARCHAR(32) NOT NULL DEFAULT 'DIRECT', audience_spec_json TEXT NOT NULL DEFAULT '{}',
    queued_submission_id VARCHAR(255), turn_id VARCHAR(255), last_error TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_agent_messages_project_id ON agent_messages(project_id);
CREATE INDEX idx_agent_messages_to_agent_status ON agent_messages(to_agent_id, status);
CREATE INDEX idx_agent_messages_conversation_id ON agent_messages(conversation_id);

CREATE TABLE human_approvals (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id), agent_id UUID NOT NULL REFERENCES agents(id),
    codex_request_id VARCHAR(255) NOT NULL, method VARCHAR(255) NOT NULL, type VARCHAR(64) NOT NULL, control_mode VARCHAR(64) NOT NULL,
    risk VARCHAR(64) NOT NULL, status VARCHAR(64) NOT NULL, thread_id VARCHAR(255) NOT NULL, turn_id VARCHAR(255), item_id VARCHAR(255),
    summary TEXT NOT NULL, request_payload TEXT NOT NULL, response_payload TEXT, last_error TEXT, policy_action VARCHAR(128),
    policy_environment VARCHAR(64), policy_effect VARCHAR(32), policy_rule_id UUID REFERENCES policy_rules(id), preauthorization_grant_id UUID,
    effect_digest VARCHAR(64), remote_interaction_id UUID, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_human_approvals_project_created ON human_approvals(project_id, created_at DESC);
CREATE INDEX idx_human_approvals_agent_status ON human_approvals(agent_id, status);
CREATE INDEX idx_human_approvals_status_created ON human_approvals(status, created_at DESC);
CREATE INDEX idx_human_approvals_policy_rule ON human_approvals(policy_rule_id);
CREATE INDEX idx_human_approvals_preauthorization_grant ON human_approvals(preauthorization_grant_id);

CREATE TABLE operational_environments (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL, kind VARCHAR(32) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, CONSTRAINT uq_operational_environment UNIQUE (project_id, key)
);
CREATE TABLE operational_services (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES operational_environments(id) ON DELETE CASCADE, key VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL, health_url TEXT, readiness_url TEXT, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, CONSTRAINT uq_operational_service UNIQUE (environment_id, key)
);
CREATE TABLE operational_runbooks (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    environment_id UUID NOT NULL REFERENCES operational_environments(id) ON DELETE CASCADE, key VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL, action VARCHAR(128) NOT NULL, description TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    version INTEGER NOT NULL DEFAULT 1, definition_json TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operational_runbook UNIQUE (project_id, key)
);
CREATE TABLE operation_runs (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, runbook_id UUID NOT NULL REFERENCES operational_runbooks(id),
    environment_id UUID NOT NULL REFERENCES operational_environments(id), requested_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    requested_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL, requested_by VARCHAR(128) NOT NULL, action VARCHAR(128) NOT NULL,
    environment_key VARCHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, policy_effect VARCHAR(32) NOT NULL,
    policy_rule_id UUID REFERENCES policy_rules(id) ON DELETE SET NULL, runbook_snapshot TEXT NOT NULL, parameters_json TEXT NOT NULL,
    approved_by VARCHAR(128), last_error TEXT, created_at TIMESTAMPTZ NOT NULL, approved_at TIMESTAMPTZ, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
CREATE INDEX idx_operation_runs_project_created ON operation_runs(project_id, created_at DESC);
CREATE INDEX idx_operation_runs_status ON operation_runs(status);
CREATE INDEX idx_operation_runs_runbook ON operation_runs(runbook_id, created_at DESC);
CREATE TABLE operation_step_runs (
    id UUID PRIMARY KEY, operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE, step_key VARCHAR(64) NOT NULL,
    step_name VARCHAR(128) NOT NULL, step_type VARCHAR(32) NOT NULL, position INTEGER NOT NULL, status VARCHAR(32) NOT NULL,
    summary TEXT, evidence TEXT, exit_code INTEGER, duration_ms BIGINT, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ
);
CREATE INDEX idx_operation_step_runs_run ON operation_step_runs(operation_run_id, position);
CREATE TABLE operation_external_waits (
    id UUID PRIMARY KEY, operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
    step_run_id UUID NOT NULL REFERENCES operation_step_runs(id) ON DELETE CASCADE, provider VARCHAR(32) NOT NULL, mode VARCHAR(16) NOT NULL,
    repository VARCHAR(255) NOT NULL, workflow VARCHAR(255) NOT NULL, ref VARCHAR(255) NOT NULL, expected_head_sha VARCHAR(64) NOT NULL,
    external_run_id BIGINT, external_url TEXT, correlation_not_before TIMESTAMPTZ, deadline TIMESTAMPTZ NOT NULL, status VARCHAR(32) NOT NULL,
    last_observed_status VARCHAR(32), last_observed_conclusion VARCHAR(32), created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operation_external_wait_step UNIQUE (step_run_id)
);
CREATE INDEX idx_operation_external_waits_status ON operation_external_waits(status, deadline);
CREATE INDEX idx_operation_external_waits_external_run ON operation_external_waits(provider, external_run_id);
CREATE INDEX idx_operation_external_waits_correlation ON operation_external_waits(provider, repository, workflow, ref, expected_head_sha);
CREATE TABLE github_webhook_deliveries (delivery_id VARCHAR(128) PRIMARY KEY, event VARCHAR(64) NOT NULL, payload_sha256 VARCHAR(64) NOT NULL, received_at TIMESTAMPTZ NOT NULL);
CREATE TABLE operation_events (
    id UUID PRIMARY KEY, operation_run_id UUID NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, target_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    event_type VARCHAR(64) NOT NULL, payload TEXT NOT NULL, status VARCHAR(32) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    queued_submission_id VARCHAR(255), turn_id VARCHAR(255), last_error TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_operation_event UNIQUE (operation_run_id, event_type)
);
CREATE INDEX idx_operation_events_delivery ON operation_events(status, created_at);

CREATE TABLE workspace_cleanup_records (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    working_directory TEXT NOT NULL, branch VARCHAR(255), outcome VARCHAR(32) NOT NULL, reason TEXT NOT NULL, freed_bytes BIGINT, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_workspace_cleanup_project_created ON workspace_cleanup_records(project_id, created_at DESC);
CREATE TABLE node_enrollment_tokens (
    id UUID PRIMARY KEY, token_hash VARCHAR(64) NOT NULL UNIQUE, requested_name VARCHAR(128) NOT NULL,
    requested_trust_level VARCHAR(32) NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_node_enrollment_tokens_expires ON node_enrollment_tokens(expires_at);
CREATE TABLE node_commands (
    id UUID PRIMARY KEY, node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    runtime_generation BIGINT NOT NULL DEFAULT 0, command_type VARCHAR(64) NOT NULL, idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    payload_json TEXT NOT NULL, status VARCHAR(32) NOT NULL, lease_until TIMESTAMPTZ, result_json TEXT, last_error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL, leased_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
CREATE INDEX idx_node_commands_node_status ON node_commands(node_id, status, created_at);
CREATE TABLE agent_message_deliveries (
    id UUID PRIMARY KEY, message_id UUID NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
    to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE, status VARCHAR(32) NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
    queued_submission_id VARCHAR(255), turn_id VARCHAR(255), last_error TEXT, processing_started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, CONSTRAINT uq_agent_message_delivery UNIQUE (message_id, to_agent_id)
);
CREATE INDEX idx_message_deliveries_agent_status ON agent_message_deliveries(to_agent_id, status);
CREATE INDEX idx_message_deliveries_turn_id ON agent_message_deliveries(turn_id) WHERE turn_id IS NOT NULL;
CREATE TABLE agent_groups (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, CONSTRAINT uq_agent_group_name UNIQUE (project_id, name)
);
CREATE TABLE agent_group_memberships (
    group_id UUID NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE, agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (group_id, agent_id)
);
CREATE TABLE node_request_nonces (
    id UUID PRIMARY KEY, node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE, nonce VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, CONSTRAINT uq_node_request_nonce UNIQUE (node_id, nonce)
);
CREATE INDEX idx_node_request_nonces_expires_at ON node_request_nonces(expires_at);
CREATE TABLE remote_codex_interactions (
    id UUID PRIMARY KEY, node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE, agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    runtime_generation BIGINT NOT NULL, runtime_type VARCHAR(32) NOT NULL, runtime_session_id VARCHAR(255) NOT NULL,
    codex_request_id VARCHAR(255) NOT NULL, method VARCHAR(255) NOT NULL, params_json TEXT NOT NULL, status VARCHAR(32) NOT NULL,
    response_json TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ,
    CONSTRAINT uq_remote_codex_request UNIQUE (node_id, agent_id, runtime_generation, codex_request_id)
);
CREATE INDEX idx_remote_codex_interactions_status ON remote_codex_interactions(status, created_at);
CREATE INDEX idx_remote_codex_interactions_agent ON remote_codex_interactions(agent_id, runtime_generation);
ALTER TABLE human_approvals ADD CONSTRAINT fk_human_approvals_remote_interaction FOREIGN KEY (remote_interaction_id) REFERENCES remote_codex_interactions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX ux_human_approvals_remote_interaction ON human_approvals(remote_interaction_id) WHERE remote_interaction_id IS NOT NULL;
CREATE TABLE node_runtime_snapshots (
    id UUID PRIMARY KEY, node_id UUID NOT NULL REFERENCES execution_nodes(id) ON DELETE CASCADE, agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    runtime_generation BIGINT NOT NULL, runtime_type VARCHAR(32) NOT NULL, runtime_session_id VARCHAR(255), source_directory TEXT,
    working_directory TEXT, branch VARCHAR(255), runtime_status VARCHAR(32) NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_node_runtime_snapshot UNIQUE (node_id, agent_id)
);
CREATE INDEX idx_node_runtime_snapshots_agent_generation ON node_runtime_snapshots(agent_id, runtime_generation);
CREATE TABLE task_dependencies (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dependency_type VARCHAR(32) NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (task_id, depends_on_task_id),
    CONSTRAINT chk_task_dependency_not_self CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
CREATE TABLE communication_rules (
    id UUID PRIMARY KEY, from_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, action VARCHAR(32) NOT NULL, effect VARCHAR(32) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_communication_rule UNIQUE (from_project_id, to_project_id, action), CONSTRAINT chk_communication_rule_projects CHECK (from_project_id <> to_project_id)
);
CREATE INDEX idx_communication_rules_from_to ON communication_rules(from_project_id, to_project_id, enabled);
CREATE TABLE operational_signals (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source VARCHAR(64) NOT NULL,
    signal_type VARCHAR(128) NOT NULL, severity VARCHAR(32) NOT NULL, fingerprint VARCHAR(255) NOT NULL, correlation_key VARCHAR(255),
    payload_json TEXT NOT NULL, status VARCHAR(32) NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_operational_signals_project_status_last_seen ON operational_signals(project_id, status, last_seen_at DESC);
CREATE INDEX idx_operational_signals_fingerprint ON operational_signals(project_id, fingerprint, last_seen_at DESC);
CREATE TABLE operational_incidents (
    id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, incident_type VARCHAR(128) NOT NULL,
    severity VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, fingerprint VARCHAR(255) NOT NULL, title VARCHAR(255) NOT NULL, summary TEXT NOT NULL,
    suspected_change VARCHAR(255), operational_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, wake_status VARCHAR(32) NOT NULL,
    wake_attempts INTEGER NOT NULL DEFAULT 0, wake_command_id UUID REFERENCES node_commands(id) ON DELETE SET NULL,
    queued_submission_id VARCHAR(255), turn_id VARCHAR(255), last_wake_error TEXT, resolution_summary TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_operational_incidents_project_status ON operational_incidents(project_id, status, updated_at DESC);
CREATE INDEX idx_operational_incidents_fingerprint ON operational_incidents(project_id, fingerprint, updated_at DESC);
CREATE INDEX idx_operational_incidents_wake ON operational_incidents(wake_status, updated_at ASC);
CREATE TABLE operational_incident_signals (
    incident_id UUID NOT NULL REFERENCES operational_incidents(id) ON DELETE CASCADE, signal_id UUID NOT NULL REFERENCES operational_signals(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (incident_id, signal_id)
);
CREATE INDEX idx_operational_incident_signals_signal ON operational_incident_signals(signal_id);
