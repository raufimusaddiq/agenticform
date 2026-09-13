ALTER TABLE tasks ADD COLUMN parent_task_id UUID REFERENCES tasks(id);

CREATE INDEX ix_tasks_parent_task_id ON tasks(parent_task_id);
