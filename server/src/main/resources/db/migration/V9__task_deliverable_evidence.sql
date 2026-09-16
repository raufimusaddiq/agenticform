ALTER TABLE tasks ADD COLUMN deliverable VARCHAR(32);
ALTER TABLE tasks ADD COLUMN delivery_stage VARCHAR(32);
ALTER TABLE tasks ADD COLUMN review_required BOOLEAN;
ALTER TABLE tasks ADD COLUMN architecture_required BOOLEAN;
ALTER TABLE tasks ADD COLUMN deployment_required BOOLEAN;
ALTER TABLE tasks ADD COLUMN environment_key VARCHAR(64);
ALTER TABLE tasks ADD COLUMN evidence_json TEXT;
ALTER TABLE tasks ADD COLUMN delivery_environment VARCHAR(64);
ALTER TABLE tasks ADD COLUMN delivery_revision VARCHAR(256);
ALTER TABLE tasks ADD COLUMN delivery_artifact_digest VARCHAR(256);
ALTER TABLE tasks ADD COLUMN delivery_operation_run_id UUID;
ALTER TABLE tasks ADD COLUMN delivery_verified_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN delivery_health_evidence TEXT;

-- Derive the requested deliverable from the persisted kind. Task kinds are already
-- server-owned, so this is a deterministic mapping, not prompt-word inference.
UPDATE tasks SET deliverable = CASE kind
    WHEN 'ORCHESTRATION' THEN 'GENERAL'
    WHEN 'ARCHITECTURE' THEN 'ANALYSIS'
    WHEN 'IMPLEMENTATION' THEN 'IMPLEMENTATION'
    WHEN 'REVIEW' THEN 'REVIEW'
    WHEN 'TEST' THEN 'TEST'
    WHEN 'OPERATIONS' THEN 'OPERATIONS'
    ELSE 'GENERAL'
END;

-- Backfill every existing row. Historical tasks were not created under the
-- deliverable contract, so they keep readable prose and are exempt from
-- retroactive deployment requirements. Backfill must cover all rows (not only
-- implementation kinds) or the SET NOT NULL statements below fail on a database
-- that already contains review/architecture/orchestration tasks.
UPDATE tasks SET review_required = (deliverable = 'IMPLEMENTATION');
UPDATE tasks SET architecture_required = FALSE;
UPDATE tasks SET deployment_required = FALSE;

-- A completed historical task stays completed; nothing is silently re-verified.
UPDATE tasks SET delivery_stage = CASE
    WHEN status = 'COMPLETED' THEN 'IMPLEMENTED'
    ELSE 'NOT_STARTED'
END;

UPDATE tasks SET review_required = FALSE WHERE review_required IS NULL;
UPDATE tasks SET architecture_required = FALSE WHERE architecture_required IS NULL;
UPDATE tasks SET deployment_required = FALSE WHERE deployment_required IS NULL;
UPDATE tasks SET delivery_stage = 'NOT_STARTED' WHERE delivery_stage IS NULL;
UPDATE tasks SET deliverable = 'GENERAL' WHERE deliverable IS NULL;

ALTER TABLE tasks ALTER COLUMN deliverable SET DEFAULT 'GENERAL';
ALTER TABLE tasks ALTER COLUMN deliverable SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN delivery_stage SET DEFAULT 'NOT_STARTED';
ALTER TABLE tasks ALTER COLUMN delivery_stage SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN review_required SET DEFAULT FALSE;
ALTER TABLE tasks ALTER COLUMN review_required SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN architecture_required SET DEFAULT FALSE;
ALTER TABLE tasks ALTER COLUMN architecture_required SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN deployment_required SET DEFAULT FALSE;
ALTER TABLE tasks ALTER COLUMN deployment_required SET NOT NULL;

CREATE INDEX ix_tasks_deliverable ON tasks(project_id, deliverable, delivery_stage);
