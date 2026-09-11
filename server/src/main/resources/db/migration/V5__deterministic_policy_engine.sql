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
    CONSTRAINT chk_policy_rule_scope CHECK (
        (scope_type = 'GLOBAL' AND scope_id IS NULL)
        OR (scope_type IN ('PROJECT', 'AGENT', 'TASK') AND scope_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_policy_rule_matcher
    ON policy_rules(scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), action, environment);
CREATE INDEX idx_policy_rules_enabled ON policy_rules(enabled);
CREATE INDEX idx_policy_rules_scope ON policy_rules(scope_type, scope_id);

INSERT INTO policy_rules(id, scope_type, scope_id, action, environment, effect, description, enabled, created_at, updated_at) VALUES
('00000000-0000-0000-0000-000000000001', 'GLOBAL', NULL, '*', '*', 'ALLOW', 'Default HOTL behavior: allow actions unless a more specific rule overrides it.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000002', 'GLOBAL', NULL, 'PRODUCTION_DEPLOY', 'production', 'REQUIRE_HUMAN', 'Production deploy/release requires fresh human approval.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000003', 'GLOBAL', NULL, 'PRODUCTION_DML', 'production', 'REQUIRE_HUMAN', 'Production data mutation requires fresh human approval.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000004', 'GLOBAL', NULL, 'DELETE_DATA', '*', 'REQUIRE_HUMAN', 'Deletion of persistent or business data requires fresh human approval.', TRUE, NOW(), NOW()),
('00000000-0000-0000-0000-000000000005', 'GLOBAL', NULL, 'USER_INPUT', '*', 'REQUIRE_HUMAN', 'Questions that genuinely require operator input are escalated to a human.', TRUE, NOW(), NOW());

ALTER TABLE human_approvals
    ADD COLUMN policy_action VARCHAR(128),
    ADD COLUMN policy_environment VARCHAR(64),
    ADD COLUMN policy_effect VARCHAR(32),
    ADD COLUMN policy_rule_id UUID REFERENCES policy_rules(id),
    ADD COLUMN preauthorization_grant_id UUID;

CREATE INDEX idx_human_approvals_policy_rule ON human_approvals(policy_rule_id);
CREATE INDEX idx_human_approvals_preauthorization_grant ON human_approvals(preauthorization_grant_id);
