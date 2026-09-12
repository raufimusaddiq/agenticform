ALTER TABLE human_approvals
    ADD COLUMN effect_digest VARCHAR(64);

ALTER TABLE execution_nodes
    ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE agents
    ADD COLUMN capability_profile VARCHAR(32) NOT NULL DEFAULT 'IMPLEMENTER';

UPDATE agents
SET capability_profile = 'OPS'
WHERE agent_role = 'OPERATIONAL' OR system_managed = TRUE;

CREATE TABLE task_dependencies (
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    dependency_type VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (task_id, depends_on_task_id),
    CONSTRAINT chk_task_dependency_not_self CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

CREATE TABLE communication_rules (
    id UUID PRIMARY KEY,
    from_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    action VARCHAR(32) NOT NULL,
    effect VARCHAR(32) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT uq_communication_rule UNIQUE (from_project_id, to_project_id, action),
    CONSTRAINT chk_communication_rule_projects CHECK (from_project_id <> to_project_id)
);
CREATE INDEX idx_communication_rules_from_to ON communication_rules(from_project_id, to_project_id, enabled);

ALTER TABLE agent_message_deliveries
    ADD COLUMN processing_started_at TIMESTAMPTZ,
    ADD COLUMN completed_at TIMESTAMPTZ;

CREATE INDEX idx_message_deliveries_turn_id ON agent_message_deliveries(codex_turn_id)
    WHERE codex_turn_id IS NOT NULL;
