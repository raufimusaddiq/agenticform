ALTER TABLE tasks ADD COLUMN kind VARCHAR(32);

UPDATE tasks t
SET kind = CASE
    WHEN a.capability_profile = 'ORCHESTRATOR' THEN 'ORCHESTRATION'
    WHEN a.capability_profile = 'ARCHITECT' THEN 'ARCHITECTURE'
    WHEN a.capability_profile = 'REVIEWER' THEN 'REVIEW'
    WHEN a.capability_profile = 'OPS' THEN 'OPERATIONS'
    WHEN lower(t.title) LIKE '%test%' THEN 'TEST'
    ELSE 'IMPLEMENTATION'
END
FROM agents a
WHERE a.id = t.assigned_agent_id;

UPDATE tasks SET kind = 'GENERAL' WHERE kind IS NULL;
ALTER TABLE tasks ALTER COLUMN kind SET DEFAULT 'GENERAL';
ALTER TABLE tasks ALTER COLUMN kind SET NOT NULL;
CREATE INDEX ix_tasks_project_kind ON tasks(project_id, kind);
