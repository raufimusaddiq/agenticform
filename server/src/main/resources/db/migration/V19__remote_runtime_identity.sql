ALTER TABLE remote_codex_interactions
    ADD COLUMN runtime_type VARCHAR(32),
    ADD COLUMN runtime_session_id VARCHAR(255);

UPDATE remote_codex_interactions interaction
SET runtime_type = agent.runtime_type,
    runtime_session_id = agent.runtime_session_id
FROM agents agent
WHERE agent.id = interaction.agent_id;

ALTER TABLE remote_codex_interactions
    ALTER COLUMN runtime_type SET NOT NULL,
    ALTER COLUMN runtime_session_id SET NOT NULL;
