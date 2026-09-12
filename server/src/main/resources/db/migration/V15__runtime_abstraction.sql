ALTER TABLE agents
    ADD COLUMN runtime_type VARCHAR(32),
    ADD COLUMN runtime_session_id VARCHAR(255);

UPDATE agents
SET runtime_type = 'CODEX',
    runtime_session_id = codex_thread_id
WHERE runtime_type IS NULL;

ALTER TABLE agents
    ALTER COLUMN runtime_type SET DEFAULT 'CODEX',
    ALTER COLUMN runtime_type SET NOT NULL;

CREATE UNIQUE INDEX ux_agents_runtime_session_id
    ON agents(runtime_session_id)
    WHERE runtime_session_id IS NOT NULL;
