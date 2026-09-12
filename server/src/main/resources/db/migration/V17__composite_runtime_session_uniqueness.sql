DROP INDEX IF EXISTS ux_agents_runtime_session_id;

CREATE UNIQUE INDEX ux_agents_runtime_session
ON agents(runtime_type, runtime_session_id)
WHERE runtime_session_id IS NOT NULL;
