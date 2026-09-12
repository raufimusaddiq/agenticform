ALTER TABLE tasks
    RENAME COLUMN codex_queued_submission_id TO queued_submission_id;
ALTER TABLE tasks
    RENAME COLUMN codex_turn_id TO turn_id;

ALTER TABLE agent_messages
    RENAME COLUMN codex_queued_submission_id TO queued_submission_id;
ALTER TABLE agent_messages
    RENAME COLUMN codex_turn_id TO turn_id;

ALTER TABLE agent_message_deliveries
    RENAME COLUMN codex_queued_submission_id TO queued_submission_id;
ALTER TABLE agent_message_deliveries
    RENAME COLUMN codex_turn_id TO turn_id;

ALTER TABLE operation_events
    RENAME COLUMN codex_queued_submission_id TO queued_submission_id;
ALTER TABLE operation_events
    RENAME COLUMN codex_turn_id TO turn_id;

ALTER TABLE operational_incidents
    RENAME COLUMN codex_queued_submission_id TO queued_submission_id;
ALTER TABLE operational_incidents
    RENAME COLUMN codex_turn_id TO turn_id;

ALTER INDEX idx_tasks_codex_turn_id RENAME TO idx_tasks_turn_id;
