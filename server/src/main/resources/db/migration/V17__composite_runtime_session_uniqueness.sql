ALTER TABLE node_runtime_snapshots
    RENAME COLUMN thread_id TO runtime_session_id;

DROP INDEX IF EXISTS ux_agents_runtime_session_id;

CREATE UNIQUE INDEX ux_agents_runtime_session
ON agents(runtime_type, runtime_session_id)
WHERE runtime_session_id IS NOT NULL;
