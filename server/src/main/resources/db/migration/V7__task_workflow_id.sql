ALTER TABLE tasks ADD COLUMN workflow_id UUID;
UPDATE tasks SET workflow_id = id WHERE workflow_id IS NULL;
ALTER TABLE tasks ALTER COLUMN workflow_id SET NOT NULL;
CREATE INDEX ix_tasks_workflow_id ON tasks(workflow_id);
